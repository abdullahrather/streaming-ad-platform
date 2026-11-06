/**
 * tests/privacy.test.ts
 *
 * GDPR tools: what's held about a viewer or a dashboard user, deleting it, and the
 * retention limits that delete old records on their own.
 */
import request from 'supertest';
import { OrganisationRole } from '@prisma/client';
import { createApp } from '@/app';
import { redis, viewKeys } from '@/lib/redis';
import { applyRetention } from '@/modules/account/retention';
import { clearDatabase, createTestCampaign, createTestUser, testPrisma } from './helpers/db';

const app = createApp();
const DAY = '2026-11-06';
const DAY_MS = 86_400_000;

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

const playerToken = async (viewerId: string, consent: boolean): Promise<string> => {
  const session = await request(app).post('/player/session').send({ viewerId, consent });
  return (session.body as { data: { token: string } }).data.token;
};

const signIn = async (email: string, password: string): Promise<string> => {
  const login = await request(app).post('/auth/login').send({ email, password });
  return login.body.data.token as string;
};

describe('Viewer data', () => {
  /** One viewer's data, plus another viewer whose ID ends the same way. */
  const seed = async (): Promise<void> => {
    await redis.hset('profile:viewer-a', 'Drama', '3');
    await redis.set(viewKeys('campaign-1', DAY, 'viewer-a').frequency, '2');
    await redis.set('viewer-rate:viewer-a:29000000', '5');
    await redis.hset('profile:other:viewer-a', 'Comedy', '1');
    await redis.set(viewKeys('campaign-1', DAY, 'other:viewer-a').frequency, '7');
  };

  it('gives a viewer a copy of what is held about them, and only them', async () => {
    await seed();
    const token = await playerToken('viewer-a', true);

    const response = await request(app).get('/player/data').query({ token });

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('viewer-data.json');
    expect(response.body.data).toEqual({
      viewerId: 'viewer-a',
      consent: true,
      interests: { Drama: 3 },
      adsSeen: [{ campaignId: 'campaign-1', day: DAY, ads: 2 }],
    });
  });

  it('deletes everything held about a viewer, leaving other viewers alone', async () => {
    await seed();
    const token = await playerToken('viewer-a', false);

    const response = await request(app).delete('/player/data').query({ token });

    expect(response.status).toBe(204);
    expect(await redis.exists('profile:viewer-a')).toBe(0);
    expect(await redis.exists(viewKeys('campaign-1', DAY, 'viewer-a').frequency)).toBe(0);
    expect(await redis.exists('viewer-rate:viewer-a:29000000')).toBe(0);
    expect(await redis.exists('profile:other:viewer-a')).toBe(1);
    expect(await redis.get(viewKeys('campaign-1', DAY, 'other:viewer-a').frequency)).toBe('7');
  });

  it('needs a valid player token', async () => {
    const response = await request(app).delete('/player/data').query({ token: 'forged' });
    expect(response.status).toBe(401);
  });
});

describe('Account data', () => {
  it('gives a copy of what is held about the person, without secrets', async () => {
    const user = await createTestUser({ email: 'ana@example.com' });
    const token = await signIn(user.email, user.password);
    await request(app)
      .post('/account/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: user.password, newPassword: 'Another-pass-123' });

    const response = await request(app)
      .get('/account/export')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.profile.email).toBe('ana@example.com');
    expect(data.organisations).toEqual([
      expect.objectContaining({ organisation: 'Test Organisation', role: 'OWNER' }),
    ]);
    expect(data.devices).toHaveLength(1);
    expect(data.activity.map((entry: { action: string }) => entry.action)).toContain(
      'account.password_changed',
    );
    const text = JSON.stringify(data);
    expect(text).not.toContain('$2'); // No password hash
    expect(text).not.toMatch(/refresh|secret|recovery/i);
  });

  it('deletes the account but keeps the organisation’s campaigns and history', async () => {
    const user = await createTestUser({ email: 'ben@example.com' });
    const campaign = await createTestCampaign(user.id, { status: 'PAUSED' });
    const token = await signIn(user.email, user.password);
    await request(app)
      .post('/account/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: user.password, newPassword: 'Another-pass-123' });
    const fresh = await signIn(user.email, 'Another-pass-123');

    const wrong = await request(app)
      .delete('/account')
      .set('Authorization', `Bearer ${fresh}`)
      .send({ password: 'not it' });
    const deleted = await request(app)
      .delete('/account')
      .set('Authorization', `Bearer ${fresh}`)
      .send({ password: 'Another-pass-123' });

    expect([wrong.status, deleted.status]).toEqual([422, 204]);
    // Signed out at once, and the email can't sign in again.
    const after = await request(app)
      .get('/account/sessions')
      .set('Authorization', `Bearer ${fresh}`);
    expect(after.status).toBe(401);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'ben@example.com', password: 'Another-pass-123' });
    expect(login.status).toBe(401);

    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).not.toContain('ben');
    expect(row.name).toBe('');
    expect(await testPrisma.campaign.count({ where: { id: campaign.id } })).toBe(1);
    const history = await testPrisma.auditLog.findMany({ where: { actorId: user.id } });
    expect(history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['account.password_changed', 'account.deleted']),
    );
    expect(history.every((entry) => entry.actorEmail === '' && entry.ipAddress === '')).toBe(true);
    // The email is free for a new account.
    const again = await request(app).post('/auth/register').send({
      email: 'ben@example.com',
      password: 'Fresh-pass-1234',
      name: 'Ben',
      organisationName: 'Ben Co',
    });
    expect(again.status).toBe(202);
    expect(await testPrisma.user.count({ where: { email: 'ben@example.com' } })).toBe(1);
  });

  it('refuses while campaigns would be left running with nobody to manage them', async () => {
    const user = await createTestUser();
    await createTestCampaign(user.id);
    const token = await signIn(user.email, user.password);

    const response = await request(app)
      .delete('/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: user.password });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('Pause or end them first');
  });

  it('refuses the only owner of a team until someone else is an owner', async () => {
    const owner = await createTestUser();
    const analyst = await createTestUser({ email: 'analyst@example.com' });
    await testPrisma.membership.create({
      data: {
        userId: analyst.id,
        organisationId: owner.organisationId,
        role: OrganisationRole.ANALYST,
      },
    });
    const token = await signIn(owner.email, owner.password);

    const response = await request(app)
      .delete('/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: owner.password });

    expect(response.status).toBe(409);
    expect(response.body.message).toContain('only owner');
  });
});

describe('Retention limits', () => {
  it('deletes old records and clears old IP addresses, keeping recent ones', async () => {
    const user = await createTestUser();
    const now = Date.now();
    const ago = (days: number): Date => new Date(now - days * DAY_MS);
    const session = (expiresAt: Date) => ({
      userId: user.id,
      refreshHash: `hash-${expiresAt.getTime()}`,
      expiresAt,
    });
    await testPrisma.session.createMany({ data: [session(ago(31)), session(ago(-1))] });
    await testPrisma.capturedEmail.createMany({
      data: [
        { recipient: 'a@example.com', subject: 'Old', body: '', createdAt: ago(31) },
        { recipient: 'a@example.com', subject: 'New', body: '', createdAt: ago(1) },
      ],
    });
    await testPrisma.auditLog.createMany({
      data: [
        { action: 'ancient', ipAddress: '10.0.0.1', createdAt: ago(731) },
        { action: 'old', ipAddress: '10.0.0.2', createdAt: ago(91) },
        { action: 'recent', ipAddress: '10.0.0.3', createdAt: ago(1) },
      ],
    });

    const result = await applyRetention(now);
    const again = await applyRetention(now);

    expect(result).toEqual({
      sessions: 1,
      links: 0,
      invitations: 0,
      capturedEmails: 1,
      auditIpAddresses: 2,
      auditEntries: 1,
    });
    expect(Object.values(again).every((count) => count === 0)).toBe(true);
    expect(await testPrisma.session.count()).toBe(1);
    expect((await testPrisma.capturedEmail.findMany()).map((email) => email.subject)).toEqual([
      'New',
    ]);
    const audit = await testPrisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audit.map((entry) => [entry.action, entry.ipAddress])).toEqual([
      ['old', ''],
      ['recent', '10.0.0.3'],
    ]);
  });
});
