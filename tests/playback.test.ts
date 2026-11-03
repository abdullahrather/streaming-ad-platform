/**
 * tests/playback.test.ts
 *
 * Video ads from upload to playback, using real FFmpeg conversions.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import ffmpegPath from 'ffmpeg-static';
import { CreativeStatus, OrganisationRole, Role } from '@prisma/client';
import { createApp } from '@/app';
import { storage } from '@/lib/storage';
import { probeVideo } from '@/lib/video';
import * as eventQueue from '@/modules/delivery/event-queue';
import { runTrafficTick } from '@/modules/demo/traffic';
import {
  clearDatabase,
  createTestCampaign,
  createTestShow,
  createTestUser,
  testPrisma,
} from './helpers/db';

const app = createApp();
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'playback-test-'));
const sample = path.join(scratch, 'sample.mp4');
const tiny = path.join(scratch, 'tiny.mp4');
const short = path.join(scratch, 'short.mp4');
const notVideo = path.join(scratch, 'notes.mp4');

const makeVideo = (file: string, size: string, seconds: number): void => {
  execFileSync(ffmpegPath as unknown as string, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=10:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-shortest',
    file,
  ]);
};

const login = async (user: { email: string; password: string }): Promise<string> => {
  const res = await request(app).post('/auth/login').send(user);
  return `Bearer ${(res.body as { data: { token: string } }).data.token}`;
};

const upload = (token: string, campaignId: string, file = sample) =>
  request(app)
    .post('/creatives')
    .set('Authorization', token)
    .field('campaignId', campaignId)
    .field('name', 'Launch film')
    .field('clickUrl', 'https://example.com/offer')
    .attach('file', file);

const waitForStatus = async (id: string, status: CreativeStatus) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const creative = await testPrisma.creative.findUniqueOrThrow({ where: { id } });
    if (creative.status === status) return creative;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Creative never reached ${status}`);
};

const placement = (showId: string) => ({
  showId,
  slot: 'PRE_ROLL',
  country: 'DE',
  device: 'CTV',
});

const placementWithToken = async (showId: string) => {
  const session = await request(app).post('/player/session');
  return { ...placement(showId), token: (session.body as { data: { token: string } }).data.token };
};

const matchAll = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`, 'g'))].map(
    (match) => match[1] as string,
  );

/** Creates an approved ad directly, without running a conversion. */
const approvedAd = async (campaignId: string, createdById: string) => {
  const id = `ad-${Math.random().toString(36).slice(2)}`;
  const videoKey = `creatives/${id}/video.mp4`;
  fs.mkdirSync(path.dirname(storage.localPath(videoKey)), { recursive: true });
  fs.copyFileSync(sample, storage.localPath(videoKey));

  return testPrisma.creative.create({
    data: {
      id,
      campaignId,
      createdById,
      name: 'Film',
      clickUrl: 'https://example.com/offer',
      status: CreativeStatus.APPROVED,
      videoKey,
      durationSeconds: 6,
      width: 640,
      height: 360,
    },
  });
};

beforeAll(() => {
  makeVideo(sample, '640x360', 6);
  makeVideo(tiny, '160x90', 6);
  makeVideo(short, '640x360', 2);
  fs.writeFileSync(notVideo, 'this is not a video');
});

beforeEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await testPrisma.$disconnect();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('Uploading ads', () => {
  it('converts an upload and sends it for review', async () => {
    const owner = await createTestUser();
    const campaign = await createTestCampaign(owner.id);

    const res = await upload(await login(owner), campaign.id);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PROCESSING');

    const creative = await waitForStatus(res.body.data.id as string, 'PENDING_REVIEW');
    expect(creative).toMatchObject({ width: 640, height: 360, originalKey: '' });
    expect(creative.durationSeconds).toBeCloseTo(6, 0);
    expect(creative.sizeBytes).toBeGreaterThan(0);

    const converted = await probeVideo(storage.localPath(creative.videoKey));
    expect(converted?.height).toBe(360);
    expect(fs.existsSync(storage.localPath(creative.posterKey))).toBe(true);
    expect(fs.readdirSync(path.dirname(storage.localPath(creative.videoKey))).sort()).toEqual([
      'poster.jpg',
      'video.mp4',
    ]);
  }, 30_000);

  it.each([
    ['a file that is not a video', notVideo, 'not a supported video'],
    ['a video that is too short', short, '5 to 120 seconds'],
    ['a video that is too small', tiny, '240 pixels'],
  ])('rejects %s', async (_name, file, message) => {
    const owner = await createTestUser();
    const campaign = await createTestCampaign(owner.id);

    const res = await upload(await login(owner), campaign.id, file);

    expect(res.status).toBe(422);
    expect(res.body.message).toContain(message);
    expect(await testPrisma.creative.count()).toBe(0);
  });

  it.each([
    ['a script link', 'javascript:alert(1)'],
    ['a relative link', '/somewhere'],
  ])('rejects %s as the click destination', async (_name, clickUrl) => {
    const owner = await createTestUser();
    const campaign = await createTestCampaign(owner.id);

    const res = await request(app)
      .post('/creatives')
      .set('Authorization', await login(owner))
      .field('campaignId', campaign.id)
      .field('name', 'Launch film')
      .field('clickUrl', clickUrl)
      .attach('file', sample);

    expect(res.status).toBe(422);
  });

  it('requires a file', async () => {
    const owner = await createTestUser();
    const campaign = await createTestCampaign(owner.id);

    const res = await request(app)
      .post('/creatives')
      .set('Authorization', await login(owner))
      .field('campaignId', campaign.id);

    expect(res.status).toBe(422);
  });

  it('is limited to people who can manage campaigns in that organisation', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const analyst = await createTestUser({
      email: 'analyst@test.com',
      organisationRole: OrganisationRole.ANALYST,
    });
    const stranger = await createTestUser({ email: 'stranger@test.com' });
    const guest = await createTestUser({ email: 'guest@test.com', role: Role.GUEST });
    const campaign = await createTestCampaign(owner.id);

    // Roles are refused before the body is read, so these requests don't send a file.
    const refuse = async (user: { email: string; password: string }) =>
      request(app)
        .post('/creatives')
        .set('Authorization', await login(user));

    const byAnalyst = await refuse(analyst);
    const byGuest = await refuse(guest);
    const byStranger = await upload(await login(stranger), campaign.id, notVideo);

    expect([byAnalyst.status, byGuest.status, byStranger.status]).toEqual([403, 403, 404]);
  });

  it('hides another company’s ads', async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const stranger = await createTestUser({ email: 'stranger@test.com' });
    const campaign = await createTestCampaign(owner.id);
    const creative = await approvedAd(campaign.id, owner.id);
    const token = await login(stranger);

    const list = await request(app)
      .get('/creatives')
      .query({ campaignId: campaign.id })
      .set('Authorization', token);
    const remove = await request(app)
      .delete(`/creatives/${creative.id}`)
      .set('Authorization', token);

    expect(list.status).toBe(404);
    expect(remove.status).toBe(404);
  });

  it('removes files when an ad or its campaign is deleted', async () => {
    const owner = await createTestUser();
    const token = await login(owner);
    const campaign = await createTestCampaign(owner.id);
    const first = await approvedAd(campaign.id, owner.id);
    const second = await approvedAd(campaign.id, owner.id);

    await request(app).delete(`/creatives/${first.id}`).set('Authorization', token);
    await request(app).delete(`/campaigns/${campaign.id}`).set('Authorization', token);

    expect(fs.existsSync(storage.localPath(first.videoKey))).toBe(false);
    expect(fs.existsSync(storage.localPath(second.videoKey))).toBe(false);
  });
});

describe('Reviewing ads', () => {
  const pendingAd = async () => {
    const owner = await createTestUser({ email: 'owner@test.com' });
    const campaign = await createTestCampaign(owner.id);
    const creative = await approvedAd(campaign.id, owner.id);
    await testPrisma.creative.update({
      where: { id: creative.id },
      data: { status: CreativeStatus.PENDING_REVIEW },
    });
    return { owner, campaign, creative };
  };

  const admin = () => createTestUser({ email: 'admin@test.com', role: Role.ADMIN });

  it('keeps a pending ad private, apart from a signed preview', async () => {
    const { creative, owner, campaign } = await pendingAd();

    const anonymous = await request(app).get(`/media/creatives/${creative.id}/video`);
    expect(anonymous.status).toBe(404);

    const list = await request(app)
      .get('/creatives')
      .query({ campaignId: campaign.id })
      .set('Authorization', await login(owner));
    const preview = await request(app).get(list.body.data[0].videoUrl as string);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('video/mp4');
  });

  it('does not accept a preview link for a different ad', async () => {
    const { creative, owner, campaign } = await pendingAd();
    const other = await approvedAd(campaign.id, owner.id);
    await testPrisma.creative.update({
      where: { id: other.id },
      data: { status: CreativeStatus.PENDING_REVIEW },
    });
    const list = await request(app)
      .get('/creatives')
      .query({ campaignId: campaign.id })
      .set('Authorization', await login(owner));
    const entry = (list.body.data as Array<{ id: string; videoUrl: string }>).find(
      ({ id }) => id === other.id,
    );
    const token = new URL(entry?.videoUrl ?? '', 'http://x').searchParams.get('t');

    const res = await request(app).get(`/media/creatives/${creative.id}/video?t=${token ?? ''}`);

    expect(res.status).toBe(404);
  });

  it('lets an admin approve, which makes the ad public and tells the uploader', async () => {
    const { creative, owner } = await pendingAd();
    const token = await login(await admin());

    const queue = await request(app).get('/admin/creatives').set('Authorization', token);
    expect(queue.body.data.map((c: { id: string }) => c.id)).toEqual([creative.id]);

    const res = await request(app)
      .post(`/admin/creatives/${creative.id}/review`)
      .set('Authorization', token)
      .send({ decision: 'APPROVE' });

    expect(res.status).toBe(204);
    const video = await request(app).get(`/media/creatives/${creative.id}/video`);
    expect(video.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await testPrisma.capturedEmail.count({ where: { recipient: owner.email } })).toBe(1);
  });

  it('needs a reason to reject, and only decides once', async () => {
    const { creative } = await pendingAd();
    const token = await login(await admin());
    const review = (body: object) =>
      request(app)
        .post(`/admin/creatives/${creative.id}/review`)
        .set('Authorization', token)
        .send(body);

    expect((await review({ decision: 'REJECT' })).status).toBe(422);
    expect((await review({ decision: 'REJECT', reason: 'Audio is too loud.' })).status).toBe(204);
    expect((await review({ decision: 'APPROVE' })).status).toBe(409);

    const stored = await testPrisma.creative.findUniqueOrThrow({ where: { id: creative.id } });
    expect(stored).toMatchObject({ status: 'REJECTED', rejectionReason: 'Audio is too loud.' });
  });

  it('is closed to everyone but platform admins', async () => {
    const { creative, owner } = await pendingAd();
    const token = await login(owner);

    const queue = await request(app).get('/admin/creatives').set('Authorization', token);
    const review = await request(app)
      .post(`/admin/creatives/${creative.id}/review`)
      .set('Authorization', token)
      .send({ decision: 'APPROVE' });

    expect([queue.status, review.status]).toEqual([403, 403]);
  });
});

describe('Serving ads through VAST', () => {
  const served = async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id, { title: 'Winter <Sale>' });
    const creative = await approvedAd(campaign.id, owner.id);

    const res = await request(app)
      .get('/vast')
      .set('User-Agent', BROWSER)
      .query(await placementWithToken(show.id));
    return { res, xml: res.text, campaign, creative, show };
  };

  const metric = async (campaignId: string) => {
    await eventQueue.drainEvents();
    return testPrisma.metric.findFirst({ where: { campaignId } });
  };

  it('returns well-formed VAST with the approved ad', async () => {
    const { res, xml, creative } = await served();

    expect(res.headers['content-type']).toContain('application/xml');
    expect(xml).toContain('<VAST version="4.2">');
    expect(xml).toContain('<Duration>00:00:06</Duration>');
    expect(matchAll(xml, 'MediaFile')[0]).toContain(`/media/creatives/${creative.id}/video`);
    expect(matchAll(xml, 'Tracking')).toHaveLength(5);
    expect(matchAll(xml, 'Impression')).toHaveLength(1);
    expect(matchAll(xml, 'ClickThrough')).toHaveLength(1);
  });

  it('works for players on other websites', async () => {
    const { res, creative } = await served();

    const video = await request(app).get(`/media/creatives/${creative.id}/video`);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(video.headers['access-control-allow-origin']).toBe('*');
    expect(video.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('keeps the signed-in API closed to other websites', async () => {
    const res = await request(app).get('/campaigns').set('Origin', 'https://other.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('escapes names in the XML', async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id, { advertiser: 'Tom & <Jerry>' });
    await approvedAd(campaign.id, owner.id);

    const { text } = await request(app)
      .get('/vast')
      .set('User-Agent', BROWSER)
      .query(await placementWithToken(show.id));

    expect(text).toContain('Tom &amp; &lt;Jerry&gt;');
  });

  it.each([
    ['pending', CreativeStatus.PENDING_REVIEW],
    ['rejected', CreativeStatus.REJECTED],
  ])('never serves a %s ad', async (_name, status) => {
    const owner = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id);
    const creative = await approvedAd(campaign.id, owner.id);
    await testPrisma.creative.update({ where: { id: creative.id }, data: { status } });

    const { text } = await request(app)
      .get('/vast')
      .set('User-Agent', BROWSER)
      .query(await placementWithToken(show.id));

    expect(text).toContain('<VAST version="4.2"/>');
  });

  it('skips a campaign with no ad and serves the next one', async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    await createTestCampaign(owner.id, { title: 'No video' });
    const withVideo = await createTestCampaign(owner.id, { advertiser: 'Has Video' });
    await approvedAd(withVideo.id, owner.id);

    const { text } = await request(app)
      .get('/vast')
      .set('User-Agent', BROWSER)
      .query(await placementWithToken(show.id));

    expect(text).toContain('Has Video');
  });

  it('counts each event once, through the signed links in the VAST', async () => {
    const { xml, campaign } = await served();
    const urls = [matchAll(xml, 'Impression')[0] as string, ...matchAll(xml, 'Tracking')].map(
      (url) => new URL(url),
    );

    for (const url of [...urls, ...urls]) {
      const res = await request(app)
        .get(url.pathname + url.search)
        .set('User-Agent', BROWSER);
      expect(res.status).toBe(204);
    }

    expect(await metric(campaign.id)).toMatchObject({
      impressions: 1,
      firstQuartiles: 1,
      midpoints: 1,
      thirdQuartiles: 1,
      completions: 1,
    });
  });

  it('counts an event when the player retries after a failed save', async () => {
    const { xml, campaign } = await served();
    const url = new URL(matchAll(xml, 'Impression')[0] as string);
    const link = url.pathname + url.search;
    jest.spyOn(eventQueue, 'enqueueEvents').mockRejectedValueOnce(new Error('Database down'));
    const failure = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = await request(app).get(link).set('User-Agent', BROWSER);
    const retry = await request(app).get(link).set('User-Agent', BROWSER);
    failure.mockRestore();

    expect(first.status).toBe(500);
    expect(retry.status).toBe(204);
    expect((await metric(campaign.id))?.impressions).toBe(1);
  });

  it('still sends the viewer on when a click cannot be saved, and counts a retry', async () => {
    const { xml, campaign } = await served();
    const url = new URL(matchAll(xml, 'ClickThrough')[0] as string);
    const link = url.pathname + url.search;
    jest.spyOn(eventQueue, 'enqueueEvents').mockRejectedValueOnce(new Error('Database down'));
    const failure = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = await request(app).get(link).set('User-Agent', BROWSER);
    const retry = await request(app).get(link).set('User-Agent', BROWSER);
    failure.mockRestore();

    expect(first.status).toBe(302);
    expect(first.headers['location']).toBe('https://example.com/offer');
    expect(retry.status).toBe(302);
    expect((await metric(campaign.id))?.clicks).toBe(1);
  });

  it('records a click and sends the viewer to the advertiser', async () => {
    const { xml, campaign } = await served();
    const url = new URL(matchAll(xml, 'ClickThrough')[0] as string);

    const res = await request(app)
      .get(url.pathname + url.search)
      .set('User-Agent', BROWSER);

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://example.com/offer');
    expect((await metric(campaign.id))?.clicks).toBe(1);
  });

  it('ignores invented tracking links', async () => {
    const res = await request(app).get('/track/impression?t=made-up');
    const click = await request(app).get('/click?t=made-up');

    expect(res.status).toBe(400);
    expect(click.status).toBe(400);
    expect(await testPrisma.metric.count()).toBe(0);
  });

  it('shows quartiles in campaign analytics', async () => {
    const owner = await createTestUser();
    const show = await createTestShow();
    const campaign = await createTestCampaign(owner.id);
    await testPrisma.metric.create({
      data: {
        campaignId: campaign.id,
        showId: show.id,
        slot: 'PRE_ROLL',
        country: 'DE',
        device: 'CTV',
        bucket: new Date(Date.now() - 3_600_000),
        impressions: 100,
        firstQuartiles: 90,
        midpoints: 80,
        thirdQuartiles: 70,
        completions: 60,
      },
    });

    const res = await request(app)
      .get('/campaigns/analytics')
      .set('Authorization', await login(owner));

    expect(res.body.data[0]).toMatchObject({
      firstQuartiles: 90,
      midpoints: 80,
      thirdQuartiles: 70,
      completions: 60,
    });
  });

  it('keeps stages in order in demo traffic', async () => {
    const owner = await createTestUser();
    await createTestShow();
    const campaign = await createTestCampaign(owner.id);
    await approvedAd(campaign.id, owner.id);

    await runTrafficTick();
    await eventQueue.drainEvents();

    const totals = await testPrisma.metric.aggregate({
      where: { campaignId: campaign.id },
      _sum: {
        impressions: true,
        firstQuartiles: true,
        midpoints: true,
        thirdQuartiles: true,
        completions: true,
      },
    });
    const { impressions, firstQuartiles, midpoints, thirdQuartiles, completions } = totals._sum;
    expect(impressions).toBeGreaterThanOrEqual(firstQuartiles as number);
    expect(firstQuartiles).toBeGreaterThanOrEqual(midpoints as number);
    expect(midpoints).toBeGreaterThanOrEqual(thirdQuartiles as number);
    expect(thirdQuartiles).toBeGreaterThanOrEqual(completions as number);
  });
});

describe('Demo site catalogue', () => {
  it('lists only shows that have an episode', async () => {
    await createTestShow('No Video');
    const show = await createTestShow('Has Video');
    await testPrisma.show.update({
      where: { id: show.id },
      data: { videoKey: `shows/${show.id}/episode.mp4` },
    });

    const res = await request(app).get('/player/catalogue');

    expect(res.body.data).toMatchObject([
      { title: 'Has Video', videoUrl: `/media/shows/${show.id}/video` },
    ]);
  });

  it('does not expose other files', async () => {
    const show = await createTestShow();

    const res = await request(app).get(`/media/shows/${show.id}/secrets`);

    expect(res.status).toBe(404);
  });
});
