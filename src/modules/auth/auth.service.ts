/**
 * src/modules/auth/auth.service.ts
 *
 * Business logic for accounts and signing in.
 * Controllers should call this service; it should never touch HTTP concerns.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OrganisationRole, TokenPurpose, type User } from '@prisma/client';
import { env } from '@/config/env';
import type { Actor } from '@/lib/actor';
import type { RequestContext } from '@/lib/http';
import { sendEmail } from '@/lib/mailer';
import { prisma } from '@/lib/prisma';
import { decrypt, hashToken, randomToken } from '@/lib/security';
import { verifyTotp } from '@/lib/totp';
import { AppError } from '@/middleware/errorHandler';
import { auditService } from '@/modules/audit/audit.service';
import { sessionService, type IssuedTokens } from './session.service';
import type { LoginDto, RegisterDto, ResetPasswordDto, TwoFactorChallengeDto } from './auth.schema';

export const BCRYPT_COST = 12;

// Compared when the email is unknown, so both paths spend the same time hashing.
// It has to be a real hash: bcrypt rejects a malformed one instantly.
const DUMMY_HASH = bcrypt.hashSync('no-account-has-this-password', BCRYPT_COST);

const VERIFICATION_HOURS = 24;
const RESET_HOURS = 1;
const CHALLENGE_TTL = '5m';
const MAX_TWO_FACTOR_FAILURES = 5;
const TWO_FACTOR_LOCK_MS = 15 * 60_000;

const lockedOut = (): AppError =>
  new AppError(429, 'Too many wrong codes. Try again in 15 minutes.', 'TWO_FACTOR_LOCKED');

/** Checks a code against a stored secret. An unreadable secret matches nothing. */
export const matchTotp = (
  encryptedSecret: string,
  code: string,
  lastStep: bigint | null,
): bigint | null => {
  try {
    return verifyTotp(decrypt(encryptedSecret), code, lastStep);
  } catch {
    return null;
  }
};

export interface SignedIn extends IssuedTokens {
  expiresIn: string;
}

export type LoginResult = SignedIn | { twoFactorRequired: true; challengeToken: string };

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: string;
  twoFactorEnabled: boolean;
  organisationId: string | null;
  organisationRole: OrganisationRole | null;
  /** Whether campaign alerts for the active organisation are emailed. */
  alertEmails: boolean;
  organisations: Array<{ id: string; name: string; role: OrganisationRole }>;
}

const challengeAudience = 'two-factor';

export class AuthService {
  /**
   * Creates an account with its own organisation. Responds the same way when
   * the email is taken, so sign-up can't be used to discover who has an account.
   */
  async register(dto: RegisterDto, context: RequestContext): Promise<void> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });

    if (existing) {
      sendEmail({
        to: dto.email,
        subject: 'You already have an account',
        body: 'Someone tried to sign up with this email. If it was you, sign in or reset your password.',
        link: `${env.APP_URL}/#/forgot-password`,
      });
      return;
    }

    const user = await prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash,
        memberships: {
          create: {
            role: OrganisationRole.OWNER,
            organisation: { create: { name: dto.organisationName } },
          },
        },
      },
      include: { memberships: { select: { organisationId: true } } },
    });

    await this.sendVerification(user);
    await auditService.record({
      action: 'account.registered',
      actorId: user.id,
      actorEmail: user.email,
      organisationId: user.memberships[0]?.organisationId ?? null,
      ipAddress: context.ipAddress,
    });
  }

  private async issueToken(userId: string, purpose: TokenPurpose, hours: number): Promise<string> {
    const token = randomToken();
    await prisma.$transaction([
      prisma.oneTimeToken.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: new Date() },
      }),
      prisma.oneTimeToken.create({
        data: {
          userId,
          purpose,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + hours * 3_600_000),
        },
      }),
    ]);
    return token;
  }

  /** Marks a token used and returns its user, once only. */
  private async consumeToken(token: string, purpose: TokenPurpose): Promise<string> {
    const invalid = new AppError(400, 'This link is invalid or has expired.');
    const stored = await prisma.oneTimeToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!stored || stored.purpose !== purpose) throw invalid;

    const { count } = await prisma.oneTimeToken.updateMany({
      where: { id: stored.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw invalid;

    return stored.userId;
  }

  private async sendVerification(user: Pick<User, 'id' | 'email'>): Promise<void> {
    const token = await this.issueToken(
      user.id,
      TokenPurpose.EMAIL_VERIFICATION,
      VERIFICATION_HOURS,
    );
    sendEmail({
      to: user.email,
      subject: 'Confirm your email',
      body: 'Confirm your email address to finish setting up your account.',
      link: `${env.APP_URL}/#/verify-email?token=${token}`,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeToken(token, TokenPurpose.EMAIL_VERIFICATION);
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    await auditService.record({ action: 'account.email_verified', actorId: userId });
  }

  async resendVerification(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt) await this.sendVerification(user);
  }

  async login(dto: LoginDto, context: RequestContext): Promise<LoginResult> {
    // 1. Look up the user by email
    const user = await prisma.user.findUnique({ where: { email: dto.email } });

    // 2. Hash either way, so response time doesn't reveal whether the email exists.
    const isValid = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !isValid) {
      if (user) {
        await auditService.record({
          action: 'auth.login_failed',
          actorId: user.id,
          actorEmail: user.email,
          ipAddress: context.ipAddress,
        });
      }
      // Deliberately vague message — don't reveal whether the email exists
      throw new AppError(401, 'Invalid email or password.');
    }

    // 3. Only the correct password learns about the account's state.
    this.assertCanSignIn(user);

    if (user.twoFactorEnabledAt) {
      const challengeToken = jwt.sign({}, env.JWT_SECRET, {
        subject: user.id,
        audience: challengeAudience,
        expiresIn: CHALLENGE_TTL,
      });
      return { twoFactorRequired: true, challengeToken };
    }

    return this.signIn(user, context);
  }

  private assertCanSignIn(user: User): void {
    if (user.suspendedAt) throw new AppError(403, 'This account is suspended.');
    if (!user.emailVerifiedAt) {
      throw new AppError(403, 'Please confirm your email first.', 'EMAIL_NOT_VERIFIED');
    }
  }

  private async signIn(user: User, context: RequestContext): Promise<SignedIn> {
    const tokens = await sessionService.create(user.id, context);
    await auditService.record({
      action: 'auth.login',
      actorId: user.id,
      actorEmail: user.email,
      ipAddress: context.ipAddress,
    });
    return { ...tokens, expiresIn: env.JWT_EXPIRES_IN };
  }

  async completeTwoFactor(dto: TwoFactorChallengeDto, context: RequestContext): Promise<SignedIn> {
    const invalid = new AppError(401, 'That code is not valid.');

    let userId: string | undefined;
    try {
      ({ sub: userId } = jwt.verify(dto.challengeToken, env.JWT_SECRET, {
        audience: challengeAudience,
      }) as jwt.JwtPayload);
    } catch {
      throw new AppError(401, 'This sign-in has expired. Please start again.');
    }

    const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    if (!user?.twoFactorSecret || !user.twoFactorEnabledAt) throw invalid;
    this.assertCanSignIn(user);
    await this.reserveTwoFactorAttempt(user);

    if (!(await this.acceptSecondFactor(user, dto.code))) {
      await auditService.record({
        action: 'auth.two_factor_failed',
        actorId: user.id,
        actorEmail: user.email,
        ipAddress: context.ipAddress,
      });
      await this.lockIfOutOfAttempts(user, context);
      throw invalid;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorFailures: 0, twoFactorLockedUntil: null },
    });
    return this.signIn(user, context);
  }

  /**
   * Counts the attempt before checking the code, per account rather than per IP
   * address, so simultaneous guesses from anywhere share the same limit.
   */
  private async reserveTwoFactorAttempt(user: User): Promise<void> {
    if (user.twoFactorLockedUntil && user.twoFactorLockedUntil > new Date()) {
      throw lockedOut();
    }

    if (user.twoFactorLockedUntil) {
      await prisma.user.updateMany({
        where: { id: user.id, twoFactorLockedUntil: user.twoFactorLockedUntil },
        data: { twoFactorFailures: 0, twoFactorLockedUntil: null },
      });
    }

    const { count } = await prisma.user.updateMany({
      where: { id: user.id, twoFactorFailures: { lt: MAX_TWO_FACTOR_FAILURES } },
      data: { twoFactorFailures: { increment: 1 } },
    });
    if (count === 0) throw lockedOut();
  }

  private async lockIfOutOfAttempts(user: User, context: RequestContext): Promise<void> {
    const { count } = await prisma.user.updateMany({
      where: {
        id: user.id,
        twoFactorFailures: { gte: MAX_TWO_FACTOR_FAILURES },
        twoFactorLockedUntil: null,
      },
      data: { twoFactorLockedUntil: new Date(Date.now() + TWO_FACTOR_LOCK_MS) },
    });
    if (count === 0) return;

    await auditService.record({
      action: 'auth.two_factor_locked',
      actorId: user.id,
      actorEmail: user.email,
      ipAddress: context.ipAddress,
    });
    sendEmail({
      to: user.email,
      subject: 'Too many two-factor attempts',
      body: 'Someone entered your password correctly, then too many wrong codes. If this was not you, change your password now.',
      link: `${env.APP_URL}/#/forgot-password`,
    });
    throw lockedOut();
  }

  /**
   * Accepts an authenticator code, or uses up one recovery code. A secret that
   * can't be decrypted, such as after ENCRYPTION_KEY changes, leaves recovery
   * codes as the way in. Conditional writes make each code usable only once.
   */
  async acceptSecondFactor(user: User, code: string): Promise<boolean> {
    const step = matchTotp(user.twoFactorSecret as string, code, user.twoFactorLastStep);
    if (step !== null) {
      const { count } = await prisma.user.updateMany({
        where: {
          id: user.id,
          OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }],
        },
        data: { twoFactorLastStep: step },
      });
      return count > 0;
    }

    const hash = hashToken(code.toUpperCase());
    if (!user.recoveryCodes.includes(hash)) return false;

    const { count } = await prisma.user.updateMany({
      where: { id: user.id, recoveryCodes: { has: hash } },
      data: { recoveryCodes: user.recoveryCodes.filter((stored) => stored !== hash) },
    });
    if (count === 0) return false;

    await auditService.record({ action: 'auth.recovery_code_used', actorId: user.id });
    return true;
  }

  /** Always succeeds from the caller's view, so it can't reveal who has an account. */
  async forgotPassword(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.suspendedAt) return;

    const token = await this.issueToken(user.id, TokenPurpose.PASSWORD_RESET, RESET_HOURS);
    sendEmail({
      to: user.email,
      subject: 'Reset your password',
      body: `Use this link within ${RESET_HOURS} hour to choose a new password.`,
      link: `${env.APP_URL}/#/reset-password?token=${token}`,
    });
  }

  /** Sets a new password and signs out every device. */
  async resetPassword(dto: ResetPasswordDto, context: RequestContext): Promise<void> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const userId = await this.consumeToken(dto.token, TokenPurpose.PASSWORD_RESET);

    // Receiving the link also proves the address belongs to them.
    const user = await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, emailVerifiedAt: new Date() },
    });
    await sessionService.endAll(userId);
    await auditService.record({
      action: 'account.password_reset',
      actorId: userId,
      actorEmail: user.email,
      ipAddress: context.ipAddress,
    });
    sendEmail({
      to: user.email,
      subject: 'Your password was changed',
      body: 'If this was not you, reset your password now and contact your administrator.',
    });
  }

  async profile(actor: Actor): Promise<Profile> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: actor.sub },
      include: {
        memberships: {
          orderBy: { createdAt: 'asc' },
          include: { organisation: { select: { id: true, name: true } } },
        },
      },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabledAt !== null,
      organisationId: actor.organisationId,
      organisationRole: actor.organisationRole,
      alertEmails:
        user.memberships.find(({ organisationId }) => organisationId === actor.organisationId)
          ?.alertEmails ?? false,
      organisations: user.memberships.map(({ organisation, role }) => ({ ...organisation, role })),
    };
  }

  async switchOrganisation(actor: Actor, organisationId: string): Promise<void> {
    const membership = await prisma.membership.findUnique({
      where: { userId_organisationId: { userId: actor.sub, organisationId } },
    });
    if (!membership) throw new AppError(404, 'Organisation not found.');

    await prisma.session.update({
      where: { id: actor.sessionId },
      data: { activeOrganisationId: organisationId },
    });
  }
}

export const authService = new AuthService();
