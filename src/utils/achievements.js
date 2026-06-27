// src/utils/achievements.js
// Central definition of all achievements + logic to check/unlock them.

const db = require('../database');

/**
 * Each achievement:
 *  id          — unique string key (stored in DB)
 *  name        — display name
 *  emoji       — icon
 *  desc        — description
 *  tier        — Bronze / Silver / Gold / Platinum (cosmetic grouping)
 *  check(user) — returns true if criteria met (user = row from db.getUser)
 *  progress(user) — returns { current, target } for progress bar display (optional)
 */
const ACHIEVEMENTS = [
  // ── Leveling ─────────────────────────────────────────────
  {
    id: 'level_5', name: 'Getting Started', emoji: '🌱', tier: 'Bronze',
    desc: 'Reach Level 5',
    check: u => u.level >= 5,
    progress: u => ({ current: Math.min(u.level, 5), target: 5 }),
  },
  {
    id: 'level_10', name: 'Rising Star', emoji: '⭐', tier: 'Silver',
    desc: 'Reach Level 10',
    check: u => u.level >= 10,
    progress: u => ({ current: Math.min(u.level, 10), target: 10 }),
  },
  {
    id: 'level_25', name: 'Veteran', emoji: '🎖️', tier: 'Gold',
    desc: 'Reach Level 25',
    check: u => u.level >= 25,
    progress: u => ({ current: Math.min(u.level, 25), target: 25 }),
  },
  {
    id: 'level_50', name: 'Legendary', emoji: '👑', tier: 'Platinum',
    desc: 'Reach Level 50',
    check: u => u.level >= 50,
    progress: u => ({ current: Math.min(u.level, 50), target: 50 }),
  },

  // ── XP Milestones ────────────────────────────────────────
  {
    id: 'xp_1000', name: 'First Thousand', emoji: '💰', tier: 'Bronze',
    desc: 'Earn 1,000 total XP',
    check: u => u.xp >= 1000,
    progress: u => ({ current: Math.min(u.xp, 1000), target: 1000 }),
  },
  {
    id: 'xp_10000', name: 'XP Hoarder', emoji: '💎', tier: 'Gold',
    desc: 'Earn 10,000 total XP',
    check: u => u.xp >= 10000,
    progress: u => ({ current: Math.min(u.xp, 10000), target: 10000 }),
  },

  // ── Duels ────────────────────────────────────────────────
  {
    id: 'duel_first_win', name: 'First Blood', emoji: '⚔️', tier: 'Bronze',
    desc: 'Win your first duel',
    check: u => (u.duel_wins || 0) >= 1,
    progress: u => ({ current: Math.min(u.duel_wins || 0, 1), target: 1 }),
  },
  {
    id: 'duel_5_wins', name: 'Duelist', emoji: '🗡️', tier: 'Silver',
    desc: 'Win 5 duels',
    check: u => (u.duel_wins || 0) >= 5,
    progress: u => ({ current: Math.min(u.duel_wins || 0, 5), target: 5 }),
  },
  {
    id: 'duel_25_wins', name: 'Gladiator', emoji: '🏆', tier: 'Gold',
    desc: 'Win 25 duels',
    check: u => (u.duel_wins || 0) >= 25,
    progress: u => ({ current: Math.min(u.duel_wins || 0, 25), target: 25 }),
  },
  {
    id: 'duel_100_wins', name: 'Undefeated Champion', emoji: '🏅', tier: 'Platinum',
    desc: 'Win 100 duels',
    check: u => (u.duel_wins || 0) >= 100,
    progress: u => ({ current: Math.min(u.duel_wins || 0, 100), target: 100 }),
  },

  // ── Daily Streak ─────────────────────────────────────────
  {
    id: 'streak_3', name: 'Consistent', emoji: '📅', tier: 'Bronze',
    desc: 'Reach a 3-day login streak',
    check: u => (u.daily_streak || 0) >= 3,
    progress: u => ({ current: Math.min(u.daily_streak || 0, 3), target: 3 }),
  },
  {
    id: 'streak_7', name: 'Dedicated', emoji: '🔥', tier: 'Gold',
    desc: 'Reach the max 7-day streak',
    check: u => (u.daily_streak || 0) >= 7,
    progress: u => ({ current: Math.min(u.daily_streak || 0, 7), target: 7 }),
  },

  // ── Shop / Titles ────────────────────────────────────────
  {
    id: 'first_title', name: 'Fashionable', emoji: '🎭', tier: 'Bronze',
    desc: 'Purchase your first title from the shop',
    check: u => !!u.title,
  },
];

const TIER_COLORS = {
  Bronze:   0xAD6A3C,
  Silver:   0xC0C0C0,
  Gold:     0xFFD700,
  Platinum: 0x7EAAFF,
};

const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum'];

/**
 * Check all achievements for a user and unlock any newly-met ones.
 * Returns an array of newly unlocked achievement objects.
 */
function checkAndUnlock(userId, guildId) {
  const user = db.getUser(userId, guildId);
  const newlyUnlocked = [];

  for (const ach of ACHIEVEMENTS) {
    if (db.hasAchievement(userId, guildId, ach.id)) continue;
    if (ach.check(user)) {
      const isNew = db.unlockAchievement(userId, guildId, ach.id);
      if (isNew) newlyUnlocked.push(ach);
    }
  }

  return newlyUnlocked;
}

function getAchievementById(id) {
  return ACHIEVEMENTS.find(a => a.id === id);
}

function getUserAchievementSummary(userId, guildId) {
  const unlockedRows = db.getUnlockedAchievements(userId, guildId);
  const unlockedIds  = new Set(unlockedRows.map(r => r.achievement_id));

  return {
    unlocked:   ACHIEVEMENTS.filter(a => unlockedIds.has(a.id)),
    locked:     ACHIEVEMENTS.filter(a => !unlockedIds.has(a.id)),
    total:      ACHIEVEMENTS.length,
    unlockedCount: unlockedIds.size,
  };
}

module.exports = {
  ACHIEVEMENTS,
  TIER_COLORS,
  TIER_ORDER,
  checkAndUnlock,
  getAchievementById,
  getUserAchievementSummary,
};