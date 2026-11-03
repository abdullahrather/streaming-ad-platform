/**
 * src/lib/redis.ts
 *
 * The Redis connection and its atomic scripts. Each script runs as one step, so
 * checks and updates can't interleave however many requests arrive at once.
 */
import { Redis } from 'ioredis';
import { env } from '@/config/env';

const ENQUEUE_EVENTS = `
local accepted = {}
for index = 2, #ARGV, 4 do
  local eventId, campaignId, viewerId, payload =
    ARGV[index], ARGV[index + 1], ARGV[index + 2], ARGV[index + 3]
  if redis.call('SET', 'seen:' .. eventId, '1', 'NX', 'EX', ARGV[1]) then
    accepted[#accepted + 1] = payload
    if campaignId ~= '' then
      redis.call('INCR', 'delivered:' .. campaignId)
      if viewerId ~= '' then redis.call('PFADD', 'reach:' .. campaignId, viewerId) end
    end
  end
end
if #accepted > 0 then
  redis.call('XADD', KEYS[1], '*', 'events', '[' .. table.concat(accepted, ',') .. ']')
end
return #accepted
`;

const DAILY_TTL = 2 * 86400;

// Checks every limit, then claims the ad, in one step. A price is per 1,000 impressions
// in cents, which is the cost of one impression in millicents.
const RESERVE_AD = `
local function number(key) return tonumber(redis.call('GET', key) or '0') end
local goal, budget, price, now, dailyBudget, dailyLimit, frequencyCap, category =
  tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4],
  tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7]), ARGV[8]

local current = math.max(number(KEYS[1]), number(KEYS[2]))
if current >= goal then return 0 end

local spent = number(KEYS[4])
if spent + price > budget then return 0 end

local dailySpent = number(KEYS[5])
if dailyBudget > 0 and dailySpent + price > dailyBudget then return 0 end

local dailyServed = number(KEYS[6])
if dailyLimit > 0 and dailyServed >= dailyLimit then return 0 end

if frequencyCap > 0 and number(KEYS[7]) >= frequencyCap then return 0 end
if category ~= '' and redis.call('SISMEMBER', KEYS[8], category) == 1 then return 0 end

redis.call('SET', KEYS[1], string.format('%.0f', current + 1))
redis.call('SET', KEYS[3], now, 'EX', 600)
redis.call('SET', KEYS[4], string.format('%.0f', spent + price))
redis.call('SET', KEYS[5], string.format('%.0f', dailySpent + price), 'EX', ${DAILY_TTL})
redis.call('SET', KEYS[6], string.format('%.0f', dailyServed + 1), 'EX', ${DAILY_TTL})
if frequencyCap > 0 then
  redis.call('INCR', KEYS[7])
  redis.call('EXPIRE', KEYS[7], ${DAILY_TTL})
end
if category ~= '' then
  redis.call('SADD', KEYS[8], category)
  redis.call('EXPIRE', KEYS[8], 3600)
end
return 1
`;

export interface ScriptedRedis extends Redis {
  /** Queues events that haven't been seen, and returns how many were new. */
  enqueueEvents(stream: string, ttlSeconds: number, ...fields: string[]): Promise<number>;
  /** Checks every limit and claims one ad. Returns 1 if it was claimed. */
  reserveAd(
    served: string,
    delivered: string,
    lastServed: string,
    spent: string,
    dailySpent: string,
    dailyServed: string,
    frequency: string,
    adBreak: string,
    goal: number,
    budgetMillicents: number,
    priceCpmCents: number,
    now: number,
    dailyBudgetMillicents: number,
    dailyImpressionLimit: number,
    frequencyCap: number,
    category: string,
  ): Promise<number>;
}

const connect = (): ScriptedRedis => {
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  client.on('error', (error: Error) => console.error('Redis:', error.message));
  client.defineCommand('enqueueEvents', { numberOfKeys: 1, lua: ENQUEUE_EVENTS });
  client.defineCommand('reserveAd', { numberOfKeys: 8, lua: RESERVE_AD });
  return client as ScriptedRedis;
};

export const redis = connect();

/** A separate connection, because waiting for new events blocks the one it uses. */
export const createBlockingRedis = (): Redis => {
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (error: Error) => console.error('Redis:', error.message));
  return client;
};

export const counterKeys = (
  campaignId: string,
): { delivered: string; served: string; lastServed: string; spent: string } => ({
  delivered: `delivered:${campaignId}`,
  served: `served:${campaignId}`,
  lastServed: `last-served:${campaignId}`,
  spent: `spent:${campaignId}`,
});

/** Keys for limits that apply per day, per viewer or per ad break. */
export const viewKeys = (
  campaignId: string,
  day: string,
  viewerId?: string,
  breakId?: string,
): { dailySpent: string; dailyServed: string; frequency: string; adBreak: string } => ({
  dailySpent: `daily-spent:${campaignId}:${day}`,
  dailyServed: `daily-served:${campaignId}:${day}`,
  frequency: `frequency:${campaignId}:${viewerId ?? 'anonymous'}:${day}`,
  adBreak: `break:${breakId ?? 'none'}`,
});

export const reachKey = (campaignId: string): string => `reach:${campaignId}`;
