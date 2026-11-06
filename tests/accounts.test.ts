/**
 * tests/accounts.test.ts
 *
 * Accounts, sessions, two-factor login, teams, the audit log and the admin console.
 */
import request from 'supertest';
import { OrganisationRole, Role } from '@prisma/client';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { decrypt, hashToken } from '@/lib/security';
import { generateTotpSecret, totpCode, verifyTotp } from '@/lib/totp';
import { deliveryService } from '@/modules/delivery/delivery.service';
import {
  clearDatabase,
  createTestCampaign,
  createTestShow,
  createTestUser,
  testPrisma,
} from './helpers/db';

const app = createApp();
const PASSWORD = 'Long-Enough-1234';
const PLACEMENT = { slot: 'PRE_ROLL', country: 'DE', device: 'CTV' } as const;

type User = { email: string; password: string };

const login = async (user: User): Promise<string> => {
  const res = await request(app).post('/auth/login').send(user);
  if (res.status !== 200) throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
};

/** Emails are sent in the background, so this waits for one to arrive. */
const emailTo = async (recipient: string, subject: string): Promise<string> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const email = await testPrisma.capturedEmail.findFirst({
      where: { recipient, subject: { contains: subject } },
      orderBy: { createdAt: 'desc' },
    });
    if (email) return new URL(email.link.replace('/#/', '/')).searchParams.get('token') ?? '';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No email to ${recipient} about ${subject}`);
};

const register = (email = 'new@test.com') =>
  request(app)
    .post('/auth/register')
    .send({ email, password: PASSWORD, name: 'New Person', organisationName: 'New Company' });

const refreshCookie = (res: request.Response): string => {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((value) => value.startsWith('refresh_token='));
  return (cookie as string).split(';')[0] as string;
};

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

describe('Signing up', () => {
  it('creates an unverified account that owns a new organisation', async () => {
    const res = await register();

    expect(res.status).toBe(202);
    const user = await testPrisma.user.findUniqueOrThrow({
      where: { email: 'new@test.com' },
      include: { memberships: { include: { organisation: true } } },
    });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.memberships).toMatchObject([
      { role: 'OWNER', organisation: { name: 'New Company' } },
    ]);
  });

  it('blocks sign-in until the email is confirmed, then allows it once', async () => {
    await register();
    const credentials = { email: 'new@test.com', password: PASSWORD };

    const blocked = await request(app).post('/auth/login').send(credentials);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_VERIFIED');

    const token = await emailTo('new@test.com', 'Confirm');
    expect((await request(app).post('/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(app).post('/auth/verify-email').send({ token })).status).toBe(400);

    expect((await request(app).post('/auth/login').send(credentials)).status).toBe(200);
  });

  it('responds the same for a taken email and leaves that account alone', async () => {
    const existing = await createTestUser({ email: 'taken@test.com' });

    const res = await register('taken@test.com');

    expect(res.status).toBe(202);
    expect(await testPrisma.user.count()).toBe(1);
    expect(res.body).toEqual((await register('free@test.com')).body);
    expect((await request(app).post('/auth/login').send(existing)).status).toBe(200);
  });

  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'a@test.com', password: 'short', name: 'Al', organisationName: 'Co' });

    expect(res.status).toBe(422);
  });

  it('stores only a hash of email tokens', async () => {
    await register();
    const token = await emailTo('new@test.com', 'Confirm');

    const stored = await testPrisma.oneTimeToken.findFirstOrThrow();
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(stored.tokenHash).not.toBe(token);
  });
});

describe('Resetting a password', () => {
  it('changes the password, works once and signs out every device', async () => {
    const user = await createTestUser({ email: 'reset@test.com' });
    const session = await login(user);

    await request(app).post('/auth/forgot-password').send({ email: user.email });
    const token = await emailTo(user.email, 'Reset');

    const reset = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'A-Brand-New-Password' });
    const replay = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'Another-New-Password' });

    expect(reset.status).toBe(200);
    expect(replay.status).toBe(400);
    expect((await request(app).get('/auth/me').set('Authorization', session)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/auth/login')
          .send({ email: user.email, password: 'A-Brand-New-Password' })
      ).status,
    ).toBe(200);
    expect((await request(app).post('/auth/login').send(user)).status).toBe(401);
  });

  it('gives the same answer for an unknown email', async () => {
    const res = await request(app).post('/auth/forgot-password').send({ email: 'nobody@test.com' });

    expect(res.status).toBe(202);
    expect(await testPrisma.capturedEmail.count()).toBe(0);
  });

  it('rejects an expired link', async () => {
    const user = await createTestUser({ email: 'old@test.com' });
    await request(app).post('/auth/forgot-password').send({ email: user.email });
    const token = await emailTo(user.email, 'Reset');
    await testPrisma.oneTimeToken.updateMany({ data: { expiresAt: new Date(0) } });

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ token, password: 'A-Brand-New-Password' });

    expect(res.status).toBe(400);
  });
});

describe('Sessions', () => {
  it('sets a refresh cookie scripts cannot read', async () => {
    const user = await createTestUser();

    const res = await request(app).post('/auth/login').send(user);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] as string;

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/auth');
  });

  it('rotates the refresh token and issues a working access token', async () => {
    const user = await createTestUser();
    const first = await request(app).post('/auth/login').send(user);

    const res = await request(app).post('/auth/refresh').set('Cookie', refreshCookie(first));

    expect(res.status).toBe(200);
    expect(refreshCookie(res)).not.toBe(refreshCookie(first));
    const me = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${res.body.data.token as string}`);
    expect(me.status).toBe(200);
  });

  it('allows two tabs to refresh at once', async () => {
    const user = await createTestUser();
    const first = await request(app).post('/auth/login').send(user);
    const cookie = refreshCookie(first);

    await request(app).post('/auth/refresh').set('Cookie', cookie);
    const second = await request(app).post('/auth/refresh').set('Cookie', cookie);

    expect(second.status).toBe(200);
    expect(second.headers['set-cookie']).toBeUndefined();
  });

  it('rotates once when refreshes overlap, leaving a cookie that works', async () => {
    const user = await createTestUser();
    const first = await request(app).post('/auth/login').send(user);
    const cookie = refreshCookie(first);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post('/auth/refresh').set('Cookie', cookie)),
    );

    expect(results.map(({ status }) => status)).toEqual(Array(8).fill(200));
    const rotated = results.filter((res) => res.headers['set-cookie']);
    expect(rotated).toHaveLength(1);

    const next = await request(app)
      .post('/auth/refresh')
      .set('Cookie', refreshCookie(rotated[0] as request.Response));
    expect(next.status).toBe(200);
  });

  it('ends the session when an old refresh token is replayed later', async () => {
    const user = await createTestUser();
    const first = await request(app).post('/auth/login').send(user);
    const stolen = refreshCookie(first);
    const rotated = await request(app).post('/auth/refresh').set('Cookie', stolen);
    await testPrisma.session.updateMany({ data: { rotatedAt: new Date(0) } });

    const replay = await request(app).post('/auth/refresh').set('Cookie', stolen);
    const legitimate = await request(app)
      .post('/auth/refresh')
      .set('Cookie', refreshCookie(rotated));

    expect(replay.status).toBe(401);
    expect(legitimate.status).toBe(401);
    expect(await testPrisma.auditLog.count({ where: { action: { contains: 'reuse' } } })).toBe(1);
  });

  it('signs out immediately, including the access token', async () => {
    const user = await createTestUser();
    const res = await request(app).post('/auth/login').send(user);
    const token = `Bearer ${res.body.data.token as string}`;

    await request(app).post('/auth/logout').set('Cookie', refreshCookie(res));

    expect((await request(app).get('/auth/me').set('Authorization', token)).status).toBe(401);
  });

  it('lists devices and signs out all the others', async () => {
    const user = await createTestUser();
    const here = await login(user);
    const elsewhere = await login(user);

    const list = await request(app).get('/account/sessions').set('Authorization', here);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    await request(app).delete('/account/sessions').set('Authorization', here);

    expect((await request(app).get('/auth/me').set('Authorization', here)).status).toBe(200);
    expect((await request(app).get('/auth/me').set('Authorization', elsewhere)).status).toBe(401);
  });

  it('cannot sign out another person’s device', async () => {
    const a = await login(await createTestUser({ email: 'a@test.com' }));
    const b = await createTestUser({ email: 'b@test.com' });
    await login(b);
    const session = await testPrisma.session.findFirstOrThrow({ where: { userId: b.id } });

    const res = await request(app)
      .delete(`/account/sessions/${session.id}`)
      .set('Authorization', a);

    expect(res.status).toBe(404);
  });

  it('changing a password needs the old one and signs out other devices', async () => {
    const user = await createTestUser();
    const here = await login(user);
    const elsewhere = await login(user);

    const wrong = await request(app)
      .post('/account/password')
      .set('Authorization', here)
      .send({ currentPassword: 'Wrong-Password', newPassword: 'A-Brand-New-Password' });
    const right = await request(app)
      .post('/account/password')
      .set('Authorization', here)
      .send({ currentPassword: user.password, newPassword: 'A-Brand-New-Password' });

    expect(wrong.status).toBe(422);
    expect(right.status).toBe(204);
    expect((await request(app).get('/auth/me').set('Authorization', elsewhere)).status).toBe(401);
    expect((await request(app).get('/auth/me').set('Authorization', here)).status).toBe(200);
  });
});

describe('Two-factor login', () => {
  const enrol = async (user: User): Promise<{ secret: string; recoveryCodes: string[] }> => {
    const token = await login(user);
    const setup = await request(app).post('/account/two-factor/setup').set('Authorization', token);
    const { secret } = setup.body.data as { secret: string };

    const enabled = await request(app)
      .post('/account/two-factor/enable')
      .set('Authorization', token)
      .send({ code: totpCode(secret) });
    expect(enabled.status).toBe(200);
    return { secret, recoveryCodes: enabled.body.data.recoveryCodes as string[] };
  };

  /** Moves the last-used step back, as if the enrolment code was used a while ago. */
  const forgetLastCode = () => testPrisma.user.updateMany({ data: { twoFactorLastStep: null } });

  const challenge = async (user: User): Promise<string> => {
    const res = await request(app).post('/auth/login').send(user);
    expect(res.body.data.token).toBeUndefined();
    return res.body.data.challengeToken as string;
  };

  it('matches the published RFC 6238 test vector', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890" in base32

    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1_111_111_109_000)).toBe('081804');
  });

  it('accepts a neighbouring step for clock drift, but no further', () => {
    const secret = generateTotpSecret();
    const now = Date.now();

    expect(verifyTotp(secret, totpCode(secret, now - 30_000), null, now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 120_000), null, now)).toBeNull();
  });

  it('stores the secret encrypted', async () => {
    const user = await createTestUser();
    const { secret } = await enrol(user);

    const stored = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.twoFactorSecret).not.toContain(secret);
    expect(decrypt(stored.twoFactorSecret as string)).toBe(secret);
  });

  it('does not turn on until a code proves the app works', async () => {
    const user = await createTestUser();
    const token = await login(user);
    await request(app).post('/account/two-factor/setup').set('Authorization', token);

    const res = await request(app)
      .post('/account/two-factor/enable')
      .set('Authorization', token)
      .send({ code: '000000' });

    expect(res.status).toBe(422);
    expect((await request(app).post('/auth/login').send(user)).body.data.token).toBeDefined();
  });

  it('requires a code at sign-in', async () => {
    const user = await createTestUser();
    const { secret } = await enrol(user);
    await forgetLastCode();

    const challengeToken = await challenge(user);
    const wrong = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken, code: '000000' });
    const right = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken, code: totpCode(secret) });

    expect(wrong.status).toBe(401);
    expect(right.status).toBe(200);
    expect(right.body.data.token).toBeDefined();
  });

  it('rejects a code that was already used', async () => {
    const user = await createTestUser();
    const { secret } = await enrol(user);
    await forgetLastCode();
    const code = totpCode(secret);

    await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code });
    const replay = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code });

    expect(replay.status).toBe(401);
  });

  it('does not accept a challenge token as an access token', async () => {
    const user = await createTestUser();
    await enrol(user);

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${await challenge(user)}`);

    expect(res.status).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const user = await createTestUser();
    const { recoveryCodes } = await enrol(user);
    const code = recoveryCodes[0] as string;

    const first = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code });
    const second = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code });

    expect(recoveryCodes).toHaveLength(8);
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('keeps recovery codes working if the secret can no longer be decrypted', async () => {
    const user = await createTestUser();
    const { recoveryCodes } = await enrol(user);
    await testPrisma.user.updateMany({ data: { twoFactorSecret: 'not.a.valid-secret' } });

    const wrong = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code: '000000' });
    const recovered = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code: recoveryCodes[0] });

    expect(wrong.status).toBe(401);
    expect(recovered.status).toBe(200);
  });

  it('locks after five wrong codes, even for the right code and a new challenge', async () => {
    const user = await createTestUser({ email: 'locked@test.com' });
    const { secret } = await enrol(user);
    await forgetLastCode();
    const challengeToken = await challenge(user);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app)
        .post('/auth/two-factor')
        .send({ challengeToken, code: '000000' });
      expect(res.status).toBe(attempt === 4 ? 429 : 401);
    }

    const sameChallenge = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken, code: totpCode(secret) });
    const newChallenge = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code: totpCode(secret) });

    expect(sameChallenge.status).toBe(429);
    expect(newChallenge.status).toBe(429);
    await emailTo(user.email, 'Too many');
  });

  it('unlocks after the wait, and a right code clears the count', async () => {
    const user = await createTestUser();
    const { secret } = await enrol(user);
    await forgetLastCode();
    await testPrisma.user.updateMany({
      data: { twoFactorFailures: 5, twoFactorLockedUntil: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code: totpCode(secret) });

    expect(res.status).toBe(200);
    const stored = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.twoFactorFailures).toBe(0);
    expect(stored.twoFactorLockedUntil).toBeNull();
  });

  it('counts simultaneous guesses', async () => {
    const user = await createTestUser();
    await enrol(user);
    const challengeToken = await challenge(user);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app).post('/auth/two-factor').send({ challengeToken, code: '000000' }),
      ),
    );

    expect(results.filter(({ status }) => status === 401).length).toBeLessThanOrEqual(4);
  });

  it('spends a recovery code once when it is sent twice at the same time', async () => {
    const user = await createTestUser();
    const { recoveryCodes } = await enrol(user);
    const code = recoveryCodes[0];
    const tokens = [await challenge(user), await challenge(user), await challenge(user)];

    const results = await Promise.all(
      tokens.map((challengeToken) =>
        request(app).post('/auth/two-factor').send({ challengeToken, code }),
      ),
    );

    expect(results.filter(({ status }) => status === 200)).toHaveLength(1);
  });

  it('needs the password and a code to turn off', async () => {
    const user = await createTestUser();
    const { secret, recoveryCodes } = await enrol(user);
    await forgetLastCode();
    const signedIn = await request(app)
      .post('/auth/two-factor')
      .send({ challengeToken: await challenge(user), code: totpCode(secret) });
    const token = `Bearer ${signedIn.body.data.token as string}`;

    const noPassword = await request(app)
      .post('/account/two-factor/disable')
      .set('Authorization', token)
      .send({ password: 'wrong-password', code: recoveryCodes[0] });
    const allowed = await request(app)
      .post('/account/two-factor/disable')
      .set('Authorization', token)
      .send({ password: user.password, code: recoveryCodes[0] });

    expect(noPassword.status).toBe(422);
    expect(allowed.status).toBe(204);
    expect((await request(app).post('/auth/login').send(user)).body.data.token).toBeDefined();
  });
});

describe('Organisations', () => {
  it('keeps two companies’ campaigns completely apart', async () => {
    const a = await createTestUser({ email: 'a@test.com' });
    const b = await createTestUser({ email: 'b@test.com' });
    const secret = await createTestCampaign(b.id, { title: 'Secret plan' });
    await createTestCampaign(a.id, { title: 'Mine' });
    const token = await login(a);

    const list = await request(app).get('/campaigns').set('Authorization', token);
    const analytics = await request(app).get('/campaigns/analytics').set('Authorization', token);
    const read = await request(app).get(`/campaigns/${secret.id}`).set('Authorization', token);
    const detail = await request(app)
      .get(`/campaigns/${secret.id}/analytics`)
      .set('Authorization', token);
    const change = await request(app)
      .patch(`/campaigns/${secret.id}`)
      .set('Authorization', token)
      .send({ status: 'PAUSED' });
    const remove = await request(app).delete(`/campaigns/${secret.id}`).set('Authorization', token);

    expect(list.body.data.map((c: { title: string }) => c.title)).toEqual(['Mine']);
    expect(analytics.body.data.map((c: { title: string }) => c.title)).toEqual(['Mine']);
    expect([read.status, detail.status, change.status, remove.status]).toEqual([
      404, 404, 404, 404,
    ]);
  });

  it('shares campaigns between members of the same organisation', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const manager = await createTestUser({ email: 'manager@test.com' });
    await testPrisma.membership.create({
      data: {
        userId: manager.id,
        organisationId: owner.organisationId,
        role: OrganisationRole.MANAGER,
      },
    });
    await testPrisma.membership.delete({
      where: {
        userId_organisationId: { userId: manager.id, organisationId: manager.organisationId },
      },
    });
    await createTestCampaign(owner.id, { title: 'Shared' });

    const res = await request(app)
      .get('/campaigns')
      .set('Authorization', await login(manager));

    expect(res.body.data).toHaveLength(1);
  });

  it('lets analysts read but not change campaigns', async () => {
    const analyst = await createTestUser({ organisationRole: OrganisationRole.ANALYST });
    const campaign = await createTestCampaign(analyst.id);
    const token = await login(analyst);

    const read = await request(app).get(`/campaigns/${campaign.id}`).set('Authorization', token);
    const change = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', token)
      .send({ status: 'PAUSED' });

    expect(read.status).toBe(200);
    expect(change.status).toBe(403);
  });

  it('applies a role change at once, without signing in again', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const campaign = await createTestCampaign(owner.id);
    const token = await login(owner);
    await testPrisma.membership.updateMany({ data: { role: OrganisationRole.ANALYST } });

    const res = await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', token)
      .send({ status: 'PAUSED' });

    expect(res.status).toBe(403);
  });

  it('switches between organisations a person belongs to, and only those', async () => {
    const user = await createTestUser();
    const stranger = await createTestUser({ email: 'stranger@test.com' });
    const token = await login(user);
    const created = await request(app)
      .post('/team/organisations')
      .set('Authorization', token)
      .send({ name: 'Second Company' });

    const me = await request(app).get('/auth/me').set('Authorization', token);
    expect(me.body.data.organisationId).toBe(created.body.data.id);
    expect(me.body.data.organisations).toHaveLength(2);

    const blocked = await request(app)
      .post('/auth/switch-organisation')
      .set('Authorization', token)
      .send({ organisationId: stranger.organisationId });
    const allowed = await request(app)
      .post('/auth/switch-organisation')
      .set('Authorization', token)
      .send({ organisationId: user.organisationId });

    expect(blocked.status).toBe(404);
    expect(allowed.status).toBe(204);
  });
});

describe('Invitations', () => {
  const invite = async (
    token: string,
    email = 'invited@test.com',
    role = 'ANALYST',
  ): Promise<string> => {
    const res = await request(app)
      .post('/team/invitations')
      .set('Authorization', token)
      .send({ email, role });
    expect(res.status).toBe(201);
    expect(res.body.data.tokenHash).toBeUndefined();
    return emailTo(email, 'Join');
  };

  it('lets a new person join with a name and password', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const token = await invite(await login(owner));

    const preview = await request(app).post('/invitations/preview').send({ token });
    expect(preview.body.data).toMatchObject({
      email: 'invited@test.com',
      role: 'ANALYST',
      hasAccount: false,
    });

    const res = await request(app)
      .post('/invitations/accept')
      .send({ token, name: 'Invited Person', password: PASSWORD });
    expect(res.status).toBe(200);

    const session = await login({ email: 'invited@test.com', password: PASSWORD });
    const me = await request(app).get('/auth/me').set('Authorization', session);
    expect(me.body.data.organisationRole).toBe('ANALYST');
    expect(me.body.data.organisationId).toBe(owner.organisationId);
  });

  it('makes an existing person sign in as the invited address', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const existing = await createTestUser({ email: 'existing@test.com' });
    const other = await createTestUser({ email: 'other@test.com' });
    const token = await invite(await login(owner), existing.email);

    const anonymous = await request(app).post('/invitations/accept').send({ token });
    const wrongPerson = await request(app)
      .post('/invitations/accept')
      .set('Authorization', await login(other))
      .send({ token });
    const right = await request(app)
      .post('/invitations/accept')
      .set('Authorization', await login(existing))
      .send({ token });

    expect(anonymous.status).toBe(401);
    expect(wrongPerson.status).toBe(401);
    expect(right.status).toBe(200);
    expect(await testPrisma.membership.count({ where: { userId: existing.id } })).toBe(2);
  });

  it('works only once and not after expiry or cancelling', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const session = await login(owner);
    const token = await invite(session);
    await request(app)
      .post('/invitations/accept')
      .send({ token, name: 'Person', password: PASSWORD });

    const replay = await request(app)
      .post('/invitations/accept')
      .send({ token, name: 'Person', password: PASSWORD });
    expect(replay.status).toBe(400);

    const expiring = await invite(session, 'late@test.com');
    await testPrisma.invitation.updateMany({
      where: { email: 'late@test.com' },
      data: { expiresAt: new Date(0) },
    });
    const expired = await request(app).post('/invitations/preview').send({ token: expiring });
    expect(expired.status).toBe(400);

    const cancelling = await invite(session, 'cancel@test.com');
    const open = await request(app).get('/team/invitations').set('Authorization', session);
    await request(app)
      .delete(`/team/invitations/${open.body.data[0].id as string}`)
      .set('Authorization', session);
    const cancelled = await request(app).post('/invitations/preview').send({ token: cancelling });
    expect(cancelled.status).toBe(400);
  });

  it('only lets owners invite', async () => {
    const manager = await createTestUser({ organisationRole: OrganisationRole.MANAGER });

    const res = await request(app)
      .post('/team/invitations')
      .set('Authorization', await login(manager))
      .send({ email: 'x@test.com', role: 'ANALYST' });

    expect(res.status).toBe(403);
  });

  it('refuses to invite an existing member', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });

    const res = await request(app)
      .post('/team/invitations')
      .set('Authorization', await login(owner))
      .send({ email: 'owner@test.com', role: 'ANALYST' });

    expect(res.status).toBe(409);
  });
});

describe('Team management', () => {
  const addMember = async (
    organisationId: string,
    role: OrganisationRole,
    email: string,
  ): Promise<{ id: string; email: string; password: string }> => {
    const user = await createTestUser({ email });
    await testPrisma.membership.deleteMany({ where: { userId: user.id } });
    await testPrisma.membership.create({ data: { userId: user.id, organisationId, role } });
    return user;
  };

  it('never leaves an organisation without an owner', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const token = await login(owner);

    const demote = await request(app)
      .patch(`/team/members/${owner.id}`)
      .set('Authorization', token)
      .send({ role: 'ANALYST' });
    const leave = await request(app)
      .delete(`/team/members/${owner.id}`)
      .set('Authorization', token);

    expect(demote.status).toBe(409);
    expect(leave.status).toBe(409);
  });

  it('allows it once there is a second owner', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const second = await addMember(owner.organisationId, OrganisationRole.OWNER, 'two@test.com');

    const res = await request(app)
      .patch(`/team/members/${owner.id}`)
      .set('Authorization', await login(second))
      .send({ role: 'MANAGER' });

    expect(res.status).toBe(204);
  });

  it('removes a member’s access straight away', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const member = await addMember(owner.organisationId, OrganisationRole.MANAGER, 'm@test.com');
    await createTestCampaign(owner.id);
    const memberToken = await login(member);

    await request(app)
      .delete(`/team/members/${member.id}`)
      .set('Authorization', await login(owner));

    const res = await request(app).get('/campaigns').set('Authorization', memberToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('lets a member leave, but not remove others', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const member = await addMember(owner.organisationId, OrganisationRole.ANALYST, 'm@test.com');
    const token = await login(member);

    const removeOwner = await request(app)
      .delete(`/team/members/${owner.id}`)
      .set('Authorization', token);
    const leave = await request(app)
      .delete(`/team/members/${member.id}`)
      .set('Authorization', token);

    expect(removeOwner.status).toBe(403);
    expect(leave.status).toBe(204);
  });

  it('hides the team from other organisations', async () => {
    const other = await createTestUser({ email: 'other@test.com' });
    const owner = await createTestUser({ email: 'owner@test.com' });

    const res = await request(app)
      .patch(`/team/members/${owner.id}`)
      .set('Authorization', await login(other))
      .send({ role: 'ANALYST' });

    expect(res.status).toBe(404);
  });
});

describe('Audit log', () => {
  it('records who changed what, limited to the organisation', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const stranger = await createTestUser({ email: 'stranger@test.com' });
    const campaign = await createTestCampaign(owner.id);
    await createTestCampaign(stranger.id);
    const token = await login(owner);
    await request(app)
      .patch(`/campaigns/${campaign.id}`)
      .set('Authorization', token)
      .send({ status: 'PAUSED' });
    await request(app)
      .post('/campaigns')
      .set('Authorization', await login(stranger))
      .send({
        title: 'Elsewhere',
        advertiser: 'Other',
        budgetCents: 100,
        cpmCents: 100,
        impressionGoal: 100,
        startsAt: '2030-01-01',
        endsAt: '2030-02-01',
      });

    const res = await request(app).get('/team/audit?action=campaign').set('Authorization', token);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      action: 'campaign.updated',
      actorEmail: 'owner@test.com',
      targetId: campaign.id,
      details: { fields: ['status'] },
    });
  });

  it('keeps analysts out', async () => {
    const analyst = await createTestUser({ organisationRole: OrganisationRole.ANALYST });

    const res = await request(app)
      .get('/team/audit')
      .set('Authorization', await login(analyst));

    expect(res.status).toBe(403);
  });

  it('records failed sign-ins', async () => {
    const user = await createTestUser({ email: 'target@test.com' });

    await request(app).post('/auth/login').send({ email: user.email, password: 'Wrong-Password' });

    expect(await testPrisma.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(1);
  });
});

describe('Admin console', () => {
  const admin = () => createTestUser({ email: 'admin@test.com', role: Role.ADMIN });

  it('is closed to everyone else, including organisation owners', async () => {
    const owner = await createTestUser();
    const token = await login(owner);

    for (const path of ['/admin/stats', '/admin/users', '/admin/organisations', '/admin/audit']) {
      expect((await request(app).get(path).set('Authorization', token)).status).toBe(403);
    }
    expect((await request(app).get('/admin/users')).status).toBe(401);
  });

  it('shows totals and searches users without exposing secrets', async () => {
    await createTestUser({ email: 'findme@test.com' });
    const token = await login(await admin());

    const stats = await request(app).get('/admin/stats').set('Authorization', token);
    const users = await request(app).get('/admin/users?q=findme').set('Authorization', token);

    expect(stats.body.data).toMatchObject({ users: 2, organisations: 2 });
    expect(users.body.data).toHaveLength(1);
    expect(users.body.data[0].passwordHash).toBeUndefined();
    expect(users.body.data[0].twoFactorSecret).toBeUndefined();
  });

  it('suspending someone ends their access at once and can be undone', async () => {
    const user = await createTestUser({ email: 'bad@test.com' });
    const token = await login(user);
    const adminToken = await login(await admin());

    await request(app)
      .patch(`/admin/users/${user.id}`)
      .set('Authorization', adminToken)
      .send({ suspended: true });

    expect((await request(app).get('/auth/me').set('Authorization', token)).status).toBe(401);
    expect((await request(app).post('/auth/login').send(user)).status).toBe(403);

    await request(app)
      .patch(`/admin/users/${user.id}`)
      .set('Authorization', adminToken)
      .send({ suspended: false });

    expect((await request(app).post('/auth/login').send(user)).status).toBe(200);
  });

  it('suspending an organisation blocks its members', async () => {
    const user = await createTestUser({ email: 'member@test.com' });
    const token = await login(user);

    await request(app)
      .patch(`/admin/organisations/${user.organisationId}`)
      .set('Authorization', await login(await admin()))
      .send({ suspended: true });

    expect((await request(app).get('/campaigns').set('Authorization', token)).status).toBe(403);
  });

  it('suspending an organisation stops its ads until it is restored', async () => {
    const user = await createTestUser({ email: 'advertiser@test.com' });
    const show = await createTestShow();
    const campaign = await createTestCampaign(user.id);
    const adminToken = await login(await admin());
    const suspend = (suspended: boolean) =>
      request(app)
        .patch(`/admin/organisations/${user.organisationId}`)
        .set('Authorization', adminToken)
        .send({ suspended });
    const decide = () => deliveryService.decide({ ...PLACEMENT, showId: show.id });

    expect((await decide())?.campaignId).toBe(campaign.id);
    await suspend(true);
    expect(await decide()).toBeNull();
    await suspend(false);
    expect((await decide())?.campaignId).toBe(campaign.id);
  });

  it('cannot suspend your own account', async () => {
    const user = await admin();

    const res = await request(app)
      .patch(`/admin/users/${user.id}`)
      .set('Authorization', await login(user))
      .send({ suspended: true });

    expect(res.status).toBe(409);
  });
});

describe('Guest account', () => {
  it('cannot use personal or team features', async () => {
    const guest = await createTestUser({ email: 'guest@test.com', role: Role.GUEST });
    const token = await login(guest);

    const statuses = await Promise.all(
      ['/account/sessions', '/team/members'].map(
        async (path) => (await request(app).get(path).set('Authorization', token)).status,
      ),
    );

    expect(statuses).toEqual([403, 403]);
  });
});

describe('Dashboard rate limit', () => {
  it('caps dashboard requests from one address, but not the player', async () => {
    const settings = env as unknown as Record<string, unknown>;
    const before = settings['DASHBOARD_RATE_LIMIT'];
    settings['DASHBOARD_RATE_LIMIT'] = 3;
    try {
      const limited = createApp();
      const dashboard = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        dashboard.push((await request(limited).get('/campaigns')).status);
      }
      const player = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        player.push((await request(limited).get('/player/catalogue')).status);
      }

      expect(dashboard).toEqual([401, 401, 401, 429]);
      expect(player).toEqual([200, 200, 200, 200]);
    } finally {
      settings['DASHBOARD_RATE_LIMIT'] = before;
    }
  });
});

describe('Local mailbox', () => {
  it('shows captured emails to this computer', async () => {
    await register();
    await emailTo('new@test.com', 'Confirm');

    const res = await request(app).get('/dev/mailbox');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ recipient: 'new@test.com' });
  });
});
