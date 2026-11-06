/**
 * src/modules/team/team.service.ts
 *
 * Organisations, their members and invitations. Owners manage the team, and an
 * organisation always keeps at least one owner.
 */
import bcrypt from 'bcryptjs';
import { OrganisationRole, Prisma, type Invitation } from '@prisma/client';
import { env } from '@/config/env';
import type { Actor } from '@/lib/actor';
import { sendEmail } from '@/lib/mailer';
import { prisma } from '@/lib/prisma';
import { hashToken, randomToken } from '@/lib/security';
import { AppError } from '@/middleware/errorHandler';
import { assertWithinPlan } from '@/modules/billing/plans';
import { BCRYPT_COST } from '@/modules/auth/auth.service';
import type { AcceptInvitationDto, InviteDto } from './team.schema';

const INVITATION_DAYS = 7;

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: OrganisationRole;
  joinedAt: Date;
}

export interface InvitationPreview {
  email: string;
  organisationName: string;
  role: OrganisationRole;
  hasAccount: boolean;
}

const organisationOf = (actor: Actor): string => {
  if (!actor.organisationId) throw new AppError(409, 'Choose an organisation first.');
  return actor.organisationId;
};

class TeamService {
  async createOrganisation(actor: Actor, name: string): Promise<{ id: string; name: string }> {
    const organisation = await prisma.organisation.create({
      data: {
        name,
        memberships: { create: { userId: actor.sub, role: OrganisationRole.OWNER } },
      },
      select: { id: true, name: true },
    });

    await prisma.session.update({
      where: { id: actor.sessionId },
      data: { activeOrganisationId: organisation.id },
    });
    return organisation;
  }

  async members(actor: Actor): Promise<Member[]> {
    const memberships = await prisma.membership.findMany({
      where: { organisationId: organisationOf(actor) },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true, name: true } } },
    });

    return memberships.map(({ userId, role, createdAt, user }) => ({
      userId,
      email: user.email,
      name: user.name,
      role,
      joinedAt: createdAt,
    }));
  }

  /** Runs inside a transaction so two owners can't remove each other at once. */
  private async assertNotLastOwner(
    tx: Prisma.TransactionClient,
    organisationId: string,
    userId: string,
  ): Promise<void> {
    const owners = await tx.membership.findMany({
      where: { organisationId, role: OrganisationRole.OWNER },
      select: { userId: true },
    });
    if (owners.length === 1 && owners[0]?.userId === userId) {
      throw new AppError(409, 'An organisation needs at least one owner.');
    }
  }

  async changeRole(actor: Actor, userId: string, role: OrganisationRole): Promise<void> {
    const organisationId = organisationOf(actor);

    await prisma.$transaction(
      async (tx) => {
        const key = { userId_organisationId: { userId, organisationId } };
        const member = await tx.membership.findUnique({ where: key });
        if (!member) throw new AppError(404, 'Member not found.');

        if (member.role === OrganisationRole.OWNER && role !== OrganisationRole.OWNER) {
          await this.assertNotLastOwner(tx, organisationId, userId);
        }
        await tx.membership.update({ where: key, data: { role } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Also ends sessions pointing at this organisation, and is how members leave. */
  async removeMember(actor: Actor, userId: string): Promise<void> {
    const organisationId = organisationOf(actor);

    await prisma.$transaction(
      async (tx) => {
        const key = { userId_organisationId: { userId, organisationId } };
        const member = await tx.membership.findUnique({ where: key });
        if (!member) throw new AppError(404, 'Member not found.');

        await this.assertNotLastOwner(tx, organisationId, userId);
        await tx.membership.delete({ where: key });
        await tx.session.updateMany({
          where: { userId, activeOrganisationId: organisationId },
          data: { activeOrganisationId: null },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  invitations(actor: Actor): Promise<Invitation[]> {
    return prisma.invitation.findMany({
      where: {
        organisationId: organisationOf(actor),
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async invite(actor: Actor, dto: InviteDto): Promise<Invitation> {
    const organisationId = organisationOf(actor);
    // Open invitations count as members, so the plan is checked when inviting. Inviting
    // someone again replaces their open invitation, so that one isn't counted twice.
    const reinvite = await prisma.invitation.count({
      where: { organisationId, email: dto.email, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    await assertWithinPlan(organisationId, 'members', prisma, reinvite > 0);

    const existing = await prisma.membership.findFirst({
      where: { organisationId, user: { email: dto.email } },
    });
    if (existing) throw new AppError(409, 'That person is already a member.');

    const token = randomToken();
    const [, invitation, organisation] = await prisma.$transaction([
      prisma.invitation.deleteMany({
        where: { organisationId, email: dto.email, acceptedAt: null },
      }),
      prisma.invitation.create({
        data: {
          organisationId,
          email: dto.email,
          role: dto.role,
          tokenHash: hashToken(token),
          invitedById: actor.sub,
          expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
        },
      }),
      prisma.organisation.findUniqueOrThrow({ where: { id: organisationId } }),
    ]);

    sendEmail({
      to: dto.email,
      subject: `Join ${organisation.name} on Campaign Analytics`,
      body: `You've been invited to join ${organisation.name}. This link lasts ${INVITATION_DAYS} days.`,
      link: `${env.APP_URL}/#/invitation?token=${token}`,
    });
    return invitation;
  }

  async revokeInvitation(actor: Actor, id: string): Promise<void> {
    const { count } = await prisma.invitation.deleteMany({
      where: { id, organisationId: organisationOf(actor), acceptedAt: null },
    });
    if (count === 0) throw new AppError(404, 'Invitation not found.');
  }

  private async openInvitation(
    token: string,
  ): Promise<Invitation & { organisation: { name: string } }> {
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organisation: { select: { name: true } } },
    });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      throw new AppError(400, 'This invitation is invalid or has expired.');
    }
    return invitation;
  }

  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.openInvitation(token);
    const user = await prisma.user.findUnique({ where: { email: invitation.email } });

    return {
      email: invitation.email,
      organisationName: invitation.organisation.name,
      role: invitation.role,
      hasAccount: user !== null,
    };
  }

  /**
   * Someone with an account must be signed in as the invited address. A new
   * person sets a password here; the emailed link has proved their address.
   */
  async accept(
    dto: AcceptInvitationDto,
    actor: Actor | undefined,
  ): Promise<{ organisationId: string; email: string; userId: string; role: OrganisationRole }> {
    const invitation = await this.openInvitation(dto.token);
    const existing = await prisma.user.findUnique({ where: { email: invitation.email } });

    let userId: string;
    if (existing) {
      if (actor?.sub !== existing.id) {
        throw new AppError(401, `Sign in as ${invitation.email} to accept this invitation.`);
      }
      userId = existing.id;
    } else {
      if (!dto.name || !dto.password) {
        throw new AppError(422, 'Enter your name and a password to create your account.');
      }
      const created = await prisma.user.create({
        data: {
          email: invitation.email,
          name: dto.name,
          passwordHash: await bcrypt.hash(dto.password, BCRYPT_COST),
          emailVerifiedAt: new Date(),
        },
      });
      userId = created.id;
    }

    const { count } = await prisma.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (count === 0) throw new AppError(400, 'This invitation has already been used.');

    await prisma.membership.upsert({
      where: {
        userId_organisationId: { userId, organisationId: invitation.organisationId },
      },
      create: {
        userId,
        organisationId: invitation.organisationId,
        role: invitation.role,
      },
      update: {},
    });

    return {
      organisationId: invitation.organisationId,
      email: invitation.email,
      userId,
      role: invitation.role,
    };
  }
}

export const teamService = new TeamService();
