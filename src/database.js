// src/database.js
// Handles all SQLite database operations using node-sqlite3-wasm
// (pure WASM — no C++ build tools required)

const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs   = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'leveling.db'));

// ─── Schema Initialization ────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id      TEXT NOT NULL,
    guild_id     TEXT NOT NULL,
    xp           INTEGER DEFAULT 0,
    level        INTEGER DEFAULT 0,
    title        TEXT DEFAULT NULL,
    duel_wins    INTEGER DEFAULT 0,
    duel_losses  INTEGER DEFAULT 0,
    last_daily   INTEGER DEFAULT 0,
    daily_streak INTEGER DEFAULT 0,
    last_fish    INTEGER DEFAULT 0,
    last_rob     INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS role_rewards (
    guild_id   TEXT NOT NULL,
    level      INTEGER NOT NULL,
    role_id    TEXT NOT NULL,
    role_name  TEXT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS voice_sessions (
    user_id    TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    joined_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS duels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT NOT NULL,
    challenger   TEXT NOT NULL,
    opponent     TEXT NOT NULL,
    wager        INTEGER NOT NULL,
    winner       TEXT DEFAULT NULL,
    status       TEXT DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id                TEXT PRIMARY KEY,
    levelup_channel_id      TEXT DEFAULT NULL,
    achievements_channel_id TEXT DEFAULT NULL,
    xp_multiplier           REAL DEFAULT 1.0,
    duel_cooldown_ms        INTEGER DEFAULT 300000,
    voice_xp_per_min        INTEGER DEFAULT 10,
    message_xp_min          INTEGER DEFAULT 15,
    message_xp_max          INTEGER DEFAULT 25,
    message_cooldown_ms     INTEGER DEFAULT 60000
  );

  CREATE TABLE IF NOT EXISTS shop_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    cost        INTEGER NOT NULL,
    item_type   TEXT DEFAULT 'title',
    item_value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS duel_cooldowns (
    user_id   TEXT NOT NULL,
    guild_id  TEXT NOT NULL,
    last_duel INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS user_achievements (
    user_id        TEXT NOT NULL,
    guild_id       TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, guild_id, achievement_id)
  );
`);

// ─── Safe column migrations (won't fail on existing DBs) ─────────────────────
// These add new columns to existing databases without losing any data.
const migrations = [
  "ALTER TABLE users ADD COLUMN last_fish INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN last_rob  INTEGER DEFAULT 0",
  "ALTER TABLE guild_config ADD COLUMN achievements_channel_id TEXT DEFAULT NULL",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists — safe to ignore */ }
}

// ─── Prepared Statements ──────────────────────────────────────────────────────

const stmts = {
  getUser: db.prepare(
    'SELECT * FROM users WHERE user_id = ? AND guild_id = ?'
  ),
  upsertUser: db.prepare(`
    INSERT INTO users (user_id, guild_id, xp, level, title, duel_wins, duel_losses, last_daily, daily_streak, last_fish, last_rob)
    VALUES (@user_id, @guild_id, @xp, @level, @title, @duel_wins, @duel_losses, @last_daily, @daily_streak, @last_fish, @last_rob)
    ON CONFLICT(user_id, guild_id) DO UPDATE SET
      xp           = excluded.xp,
      level        = excluded.level,
      title        = excluded.title,
      duel_wins    = excluded.duel_wins,
      duel_losses  = excluded.duel_losses,
      last_daily   = excluded.last_daily,
      daily_streak = excluded.daily_streak,
      last_fish    = excluded.last_fish,
      last_rob     = excluded.last_rob
  `),
  getLeaderboard: db.prepare(`
    SELECT user_id, xp, level, duel_wins, duel_losses, title
    FROM users WHERE guild_id = ?
    ORDER BY xp DESC LIMIT 10
  `),
  getRoleRewards: db.prepare(
    'SELECT * FROM role_rewards WHERE guild_id = ? ORDER BY level ASC'
  ),
  getRoleRewardByLevel: db.prepare(
    'SELECT * FROM role_rewards WHERE guild_id = ? AND level = ?'
  ),
  upsertRoleReward: db.prepare(`
    INSERT INTO role_rewards (guild_id, level, role_id, role_name)
    VALUES (@guild_id, @level, @role_id, @role_name)
    ON CONFLICT(guild_id, level) DO UPDATE SET
      role_id   = excluded.role_id,
      role_name = excluded.role_name
  `),
  deleteRoleReward: db.prepare(
    'DELETE FROM role_rewards WHERE guild_id = ? AND level = ?'
  ),
  startVoiceSession: db.prepare(
    'INSERT OR REPLACE INTO voice_sessions (user_id, guild_id, joined_at) VALUES (?, ?, ?)'
  ),
  getVoiceSession: db.prepare(
    'SELECT * FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
  ),
  endVoiceSession: db.prepare(
    'DELETE FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
  ),
  getAllVoiceSessions: db.prepare('SELECT * FROM voice_sessions'),
  getUserRank: db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM users
    WHERE guild_id = ? AND xp > (SELECT xp FROM users WHERE user_id = ? AND guild_id = ?)
  `),
  // Guild Config
  getGuildConfig: db.prepare('SELECT * FROM guild_config WHERE guild_id = ?'),
  upsertGuildConfig: db.prepare(`
    INSERT INTO guild_config (guild_id, levelup_channel_id, achievements_channel_id, xp_multiplier, duel_cooldown_ms,
      voice_xp_per_min, message_xp_min, message_xp_max, message_cooldown_ms)
    VALUES (@guild_id, @levelup_channel_id, @achievements_channel_id, @xp_multiplier, @duel_cooldown_ms,
      @voice_xp_per_min, @message_xp_min, @message_xp_max, @message_cooldown_ms)
    ON CONFLICT(guild_id) DO UPDATE SET
      levelup_channel_id      = COALESCE(excluded.levelup_channel_id, levelup_channel_id),
      achievements_channel_id = COALESCE(excluded.achievements_channel_id, achievements_channel_id),
      xp_multiplier           = excluded.xp_multiplier,
      duel_cooldown_ms        = excluded.duel_cooldown_ms,
      voice_xp_per_min        = excluded.voice_xp_per_min,
      message_xp_min          = excluded.message_xp_min,
      message_xp_max          = excluded.message_xp_max,
      message_cooldown_ms     = excluded.message_cooldown_ms
  `),
  // Duels
  createDuel: db.prepare(`
    INSERT INTO duels (guild_id, challenger, opponent, wager, status, created_at)
    VALUES (@guild_id, @challenger, @opponent, @wager, 'pending', @created_at)
  `),
  getPendingDuel: db.prepare(`
    SELECT * FROM duels WHERE guild_id = ? AND opponent = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `),
  getPendingDuelByChallenger: db.prepare(`
    SELECT * FROM duels WHERE guild_id = ? AND challenger = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `),
  resolveDuel: db.prepare(
    "UPDATE duels SET status = 'resolved', winner = ?, resolved_at = ? WHERE id = ?"
  ),
  cancelDuel: db.prepare(
    "UPDATE duels SET status = 'cancelled' WHERE id = ?"
  ),
  getDuelHistory: db.prepare(`
    SELECT * FROM duels WHERE guild_id = ? AND (challenger = ? OR opponent = ?)
    AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 5
  `),
  // Duel cooldowns
  getDuelCooldown: db.prepare(
    'SELECT * FROM duel_cooldowns WHERE user_id = ? AND guild_id = ?'
  ),
  setDuelCooldown: db.prepare(
    'INSERT OR REPLACE INTO duel_cooldowns (user_id, guild_id, last_duel) VALUES (?, ?, ?)'
  ),
  // Shop
  getShopItems: db.prepare(
    'SELECT * FROM shop_items WHERE guild_id = ? ORDER BY cost ASC'
  ),
  getShopItem: db.prepare(
    'SELECT * FROM shop_items WHERE id = ? AND guild_id = ?'
  ),
  addShopItem: db.prepare(`
    INSERT INTO shop_items (guild_id, name, description, cost, item_type, item_value)
    VALUES (@guild_id, @name, @description, @cost, @item_type, @item_value)
  `),
  removeShopItem: db.prepare(
    'DELETE FROM shop_items WHERE id = ? AND guild_id = ?'
  ),
  // Achievements
  getUnlockedAchievements: db.prepare(
    'SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ? AND guild_id = ?'
  ),
  hasAchievement: db.prepare(
    'SELECT 1 FROM user_achievements WHERE user_id = ? AND guild_id = ? AND achievement_id = ?'
  ),
  unlockAchievement: db.prepare(`
    INSERT OR IGNORE INTO user_achievements (user_id, guild_id, achievement_id, unlocked_at)
    VALUES (?, ?, ?, ?)
  `),
};

// ─── Helper: convert plain object keys to @-prefixed for named params ─────────
function p(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.startsWith('@') ? k : `@${k}`] = v;
  }
  return out;
}

// ─── XP / Level Helpers ───────────────────────────────────────────────────────

function xpForLevel(level) { return level * level * 100; }

function totalXpForLevel(level) {
  let total = 0;
  for (let i = 1; i <= level; i++) total += xpForLevel(i);
  return total;
}

function calcLevel(totalXp) {
  let level = 0, accumulated = 0;
  while (true) {
    const needed = xpForLevel(level + 1);
    if (accumulated + needed > totalXp) break;
    accumulated += needed;
    level++;
  }
  return level;
}

// ─── User helpers ─────────────────────────────────────────────────────────────

function _defaultUser(userId, guildId) {
  return {
    user_id: userId, guild_id: guildId,
    xp: 0, level: 0, title: null,
    duel_wins: 0, duel_losses: 0,
    last_daily: 0, daily_streak: 0,
    last_fish: 0, last_rob: 0,
  };
}

function _saveUser(u) {
  // Ensure new fields have defaults if missing (for old user objects)
  stmts.upsertUser.run(p({
    ...u,
    last_fish: u.last_fish || 0,
    last_rob:  u.last_rob  || 0,
  }));
}

// ─── Public API — Users ───────────────────────────────────────────────────────

function getUser(userId, guildId) {
  let user = stmts.getUser.get([userId, guildId]);
  if (!user) {
    const def = _defaultUser(userId, guildId);
    _saveUser(def);
    user = stmts.getUser.get([userId, guildId]);
  }
  return user;
}

function addXp(userId, guildId, amount) {
  const config     = getGuildConfig(guildId);
  const multiplier = config.xp_multiplier || 1.0;
  const user       = getUser(userId, guildId);
  // Don't apply multiplier to negative XP (penalties)
  const delta  = amount < 0 ? amount : Math.round(amount * multiplier);
  const newXp  = Math.max(0, user.xp + delta);
  const oldLevel = user.level;
  const newLevel = calcLevel(newXp);
  _saveUser({ ...user, xp: newXp, level: newLevel });
  return { oldLevel, newLevel, totalXp: newXp };
}

function setXp(userId, guildId, amount) {
  const user     = getUser(userId, guildId);
  const newLevel = calcLevel(amount);
  _saveUser({ ...user, xp: amount, level: newLevel });
  return { oldLevel: user.level, newLevel, totalXp: amount };
}

function resetUser(userId, guildId) {
  _saveUser(_defaultUser(userId, guildId));
}

function getProgress(totalXp, level) {
  const xpForCurrentLevel  = totalXpForLevel(level);
  const xpIntoCurrentLevel = totalXp - xpForCurrentLevel;
  const xpNeededForNext    = xpForLevel(level + 1);
  return { current: xpIntoCurrentLevel, needed: xpNeededForNext };
}

function buildProgressBar(current, needed, length = 20) {
  const filled = Math.round((current / needed) * length);
  const empty  = length - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

function getLeaderboard(guildId) { return stmts.getLeaderboard.all([guildId]); }

function getUserRank(userId, guildId) {
  const row = stmts.getUserRank.get([guildId, userId, guildId]);
  return row ? row.rank : null;
}

// ─── Guild Config ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  levelup_channel_id:      null,
  achievements_channel_id: null,
  xp_multiplier:           1.0,
  duel_cooldown_ms:        300_000,
  voice_xp_per_min:        10,
  message_xp_min:          15,
  message_xp_max:          25,
  message_cooldown_ms:     60_000,
};

function getGuildConfig(guildId) {
  return stmts.getGuildConfig.get([guildId]) || { guild_id: guildId, ...DEFAULT_CONFIG };
}

function setGuildConfig(guildId, updates) {
  const current = getGuildConfig(guildId);
  const merged  = { ...DEFAULT_CONFIG, ...current, ...updates, guild_id: guildId };
  stmts.upsertGuildConfig.run(p(merged));
}

// ─── Role Rewards ─────────────────────────────────────────────────────────────

function getRoleRewards(guildId) { return stmts.getRoleRewards.all([guildId]); }

function setRoleReward(guildId, level, roleId, roleName) {
  stmts.upsertRoleReward.run(p({ guild_id: guildId, level, role_id: roleId, role_name: roleName }));
}

function removeRoleReward(guildId, level) {
  return stmts.deleteRoleReward.run([guildId, level]).changes > 0;
}

function getRoleRewardForLevel(guildId, level) {
  return stmts.getRoleRewardByLevel.get([guildId, level]);
}

// ─── Voice Sessions ───────────────────────────────────────────────────────────

function startVoiceSession(userId, guildId) {
  stmts.startVoiceSession.run([userId, guildId, Date.now()]);
}

function endVoiceSession(userId, guildId) {
  const session = stmts.getVoiceSession.get([userId, guildId]);
  stmts.endVoiceSession.run([userId, guildId]);
  return session;
}

function getAllVoiceSessions() { return stmts.getAllVoiceSessions.all(); }

// ─── Duels ────────────────────────────────────────────────────────────────────

function createDuel(guildId, challengerId, opponentId, wager) {
  const r = stmts.createDuel.run(p({
    guild_id: guildId, challenger: challengerId,
    opponent: opponentId, wager, created_at: Date.now(),
  }));
  return r.lastInsertRowid;
}

function getPendingDuel(guildId, opponentId) {
  return stmts.getPendingDuel.get([guildId, opponentId]);
}

function getPendingDuelByChallenger(guildId, challengerId) {
  return stmts.getPendingDuelByChallenger.get([guildId, challengerId]);
}

function resolveDuel(duelId, winnerId) {
  stmts.resolveDuel.run([winnerId, Date.now(), duelId]);
}

function cancelDuel(duelId) { stmts.cancelDuel.run([duelId]); }

function getDuelHistory(guildId, userId) {
  return stmts.getDuelHistory.all([guildId, userId, userId]);
}

function recordDuelResult(guildId, winnerId, loserId, wager) {
  const winner      = getUser(winnerId, guildId);
  const loser       = getUser(loserId,  guildId);
  const actualWager = Math.min(wager, loser.xp);
  const winnerNewXp = winner.xp + actualWager;
  const loserNewXp  = Math.max(0, loser.xp - actualWager);
  _saveUser({ ...winner, xp: winnerNewXp, level: calcLevel(winnerNewXp), duel_wins: (winner.duel_wins || 0) + 1 });
  _saveUser({ ...loser,  xp: loserNewXp,  level: calcLevel(loserNewXp),  duel_losses: (loser.duel_losses || 0) + 1 });
  return { actualWager, winnerNewXp, loserNewXp };
}

function getDuelCooldown(userId, guildId) {
  return stmts.getDuelCooldown.get([userId, guildId]);
}

function setDuelCooldown(userId, guildId) {
  stmts.setDuelCooldown.run([userId, guildId, Date.now()]);
}

// ─── Daily Rewards ────────────────────────────────────────────────────────────

const DAILY_BASE_XP    = 100;
const DAILY_STREAK_CAP = 7;
const MS_PER_DAY       = 86_400_000;

function claimDaily(userId, guildId) {
  const user = getUser(userId, guildId);
  const now  = Date.now();
  const diff = now - (user.last_daily || 0);

  if (diff < MS_PER_DAY) return { success: false, remaining: MS_PER_DAY - diff };

  const streak       = diff < MS_PER_DAY * 2 ? (user.daily_streak || 0) + 1 : 1;
  const cappedStreak = Math.min(streak, DAILY_STREAK_CAP);
  const xpAwarded    = DAILY_BASE_XP + (cappedStreak - 1) * 25;
  const newXp        = user.xp + xpAwarded;
  const newLevel     = calcLevel(newXp);

  _saveUser({ ...user, xp: newXp, level: newLevel, last_daily: now, daily_streak: streak });
  return { success: true, xpAwarded, streak: cappedStreak, newXp, oldLevel: user.level, newLevel };
}

// ─── Fish Cooldown ────────────────────────────────────────────────────────────

const FISH_COOLDOWN_MS = 30 * 60_000; // 30 minutes

function canFish(userId, guildId) {
  const user      = getUser(userId, guildId);
  const lastFish  = user.last_fish || 0;
  const remaining = FISH_COOLDOWN_MS - (Date.now() - lastFish);
  return { can: remaining <= 0, remaining: Math.max(0, remaining) };
}

function setLastFish(userId, guildId) {
  const user = getUser(userId, guildId);
  _saveUser({ ...user, last_fish: Date.now() });
}

// ─── Rob Cooldown ─────────────────────────────────────────────────────────────

const ROB_COOLDOWN_MS = 10 * 60_000; // 10 minutes

function canRob(userId, guildId) {
  const user      = getUser(userId, guildId);
  const lastRob   = user.last_rob || 0;
  const remaining = ROB_COOLDOWN_MS - (Date.now() - lastRob);
  return { can: remaining <= 0, remaining: Math.max(0, remaining) };
}

function setLastRob(userId, guildId) {
  const user = getUser(userId, guildId);
  _saveUser({ ...user, last_rob: Date.now() });
}

// ─── Shop ─────────────────────────────────────────────────────────────────────

function getShopItems(guildId) { return stmts.getShopItems.all([guildId]); }
function getShopItem(itemId, guildId) { return stmts.getShopItem.get([itemId, guildId]); }

function addShopItem(guildId, name, description, cost, itemType, itemValue) {
  return stmts.addShopItem.run(p({
    guild_id: guildId, name, description, cost, item_type: itemType, item_value: itemValue,
  }));
}

function removeShopItem(itemId, guildId) {
  return stmts.removeShopItem.run([itemId, guildId]).changes > 0;
}

function buyShopItem(userId, guildId, itemId) {
  const user = getUser(userId, guildId);
  const item = getShopItem(itemId, guildId);
  if (!item) return { success: false, reason: 'Item not found.' };
  if (user.xp < item.cost) return {
    success: false,
    reason: `You need **${item.cost.toLocaleString()} XP** but only have **${user.xp.toLocaleString()}**.`,
  };
  const newXp = user.xp - item.cost;
  _saveUser({
    ...user, xp: newXp, level: calcLevel(newXp),
    title: item.item_type === 'title' ? item.item_value : user.title,
  });
  return { success: true, item, newXp };
}

// ─── Achievements ─────────────────────────────────────────────────────────────

function getUnlockedAchievements(userId, guildId) {
  return stmts.getUnlockedAchievements.all([userId, guildId]); // [{achievement_id, unlocked_at}]
}

function hasAchievement(userId, guildId, achievementId) {
  return !!stmts.hasAchievement.get([userId, guildId, achievementId]);
}

/**
 * Unlock an achievement if not already unlocked.
 * Returns true if newly unlocked, false if already had it.
 */
function unlockAchievement(userId, guildId, achievementId) {
  if (hasAchievement(userId, guildId, achievementId)) return false;
  stmts.unlockAchievement.run([userId, guildId, achievementId, Date.now()]);
  return true;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getUser, addXp, setXp, resetUser,
  getProgress, buildProgressBar,
  getLeaderboard, getUserRank,
  getGuildConfig, setGuildConfig,
  getRoleRewards, setRoleReward, removeRoleReward, getRoleRewardForLevel,
  startVoiceSession, endVoiceSession, getAllVoiceSessions,
  createDuel, getPendingDuel, getPendingDuelByChallenger,
  resolveDuel, cancelDuel, getDuelHistory, recordDuelResult,
  getDuelCooldown, setDuelCooldown,
  claimDaily,
  canFish, setLastFish, FISH_COOLDOWN_MS,
  canRob,  setLastRob,  ROB_COOLDOWN_MS,
  getShopItems, getShopItem, addShopItem, removeShopItem, buyShopItem,
  getUnlockedAchievements, hasAchievement, unlockAchievement,
  xpForLevel, totalXpForLevel, calcLevel,
  DAILY_BASE_XP, DAILY_STREAK_CAP, MS_PER_DAY,
};