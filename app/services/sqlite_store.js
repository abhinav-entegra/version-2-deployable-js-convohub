import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "local_data.db");

// Initialize SQLite database
const db = new Database(dbPath);

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    channel_name TEXT,
    content TEXT,
    msg_type TEXT DEFAULT 'text',
    file_path TEXT,
    client_msg_id TEXT,
    workspace_id INTEGER,
    is_read BOOLEAN DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    profile_pic_url TEXT,
    role TEXT,
    team_name TEXT,
    team_role TEXT,
    workspace_id INTEGER,
    is_restricted BOOLEAN DEFAULT 0,
    dm_allowlist_only BOOLEAN DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    display_name TEXT,
    team_name TEXT,
    workspace_id INTEGER,
    icon_url TEXT,
    is_private_group BOOLEAN DEFAULT 0,
    visibility TEXT DEFAULT 'all',
    post_permission_mode TEXT DEFAULT 'all_visible'
  );

  CREATE TABLE IF NOT EXISTS channel_visits (
    user_id INTEGER,
    channel_name TEXT,
    last_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_name)
  );

  CREATE TABLE IF NOT EXISTS workspace_access (
    user_id INTEGER,
    workspace_id INTEGER,
    PRIMARY KEY (user_id, workspace_id)
  );
`);

/**
 * Enhanced SQLite store that mimics the Supabase store structure
 * and provides live flowing data in a loop.
 */

export const sqlite = db;

// Helper to get formatted time
function fmtTime(ts) {
  try {
    if (!ts) return "";
    var iso = String(ts).replace(" ", "T");
    if (!iso.includes("Z") && !iso.includes("+")) iso += "Z";
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

export async function insertMessage(row) {
  const stmt = db.prepare(`
    INSERT INTO messages (sender_id, receiver_id, channel_name, content, msg_type, file_path, client_msg_id, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    row.sender_id,
    row.receiver_id || null,
    row.channel_name || null,
    row.content || "",
    row.type || "text",
    row.file_path || null,
    row.client_msg_id || null,
    row.workspace_id || 1
  );
  
  return getMessageById(info.lastInsertRowid);
}

export async function getMessageById(id) {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    timestamp: fmtTime(row.timestamp),
    raw_timestamp: row.timestamp,
    is_me: false, // Caller handles this
  };
}

export async function findMessageByClientMsgId(senderId, clientMsgId) {
  const row = db.prepare("SELECT * FROM messages WHERE sender_id = ? AND client_msg_id = ? LIMIT 1").get(senderId, clientMsgId);
  if (!row) return null;
  return {
    ...row,
    timestamp: fmtTime(row.timestamp),
    raw_timestamp: row.timestamp,
    is_me: false,
  };
}

export async function listMessagesForChannel(channelName, workspaceId, viewerWorkspaceId, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  let sql = "SELECT * FROM messages WHERE channel_name = ? AND workspace_id = ?";
  const params = [channelName, workspaceId];
  
  if (opts.beforeTs) {
    sql += " AND timestamp < ?";
    params.push(opts.beforeTs);
  }
  if (opts.afterTs) {
    sql += " AND timestamp > ?";
    params.push(opts.afterTs);
  }
  
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);
  
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    ...r,
    timestamp: fmtTime(r.timestamp),
    raw_timestamp: r.timestamp
  })).reverse();
}

export async function listDmMessages(aId, bId, workspaceId, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  let sql = `
    SELECT * FROM messages 
    WHERE channel_name IS NULL 
    AND workspace_id = ? 
    AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
  `;
  const params = [workspaceId, aId, bId, bId, aId];
  
  if (opts.beforeTs) {
    sql += " AND timestamp < ?";
    params.push(opts.beforeTs);
  }
  if (opts.afterTs) {
    sql += " AND timestamp > ?";
    params.push(opts.afterTs);
  }
  
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);
  
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    ...r,
    timestamp: fmtTime(r.timestamp),
    raw_timestamp: r.timestamp
  })).reverse();
}

export async function markDmReadForReceiver(readerId, otherId) {
  db.prepare(`
    UPDATE messages SET is_read = 1 
    WHERE receiver_id = ? AND sender_id = ? AND channel_name IS NULL
  `).run(readerId, otherId);
}

export async function upsertChannelVisit(userId, channelName) {
  db.prepare(`
    INSERT INTO channel_visits (user_id, channel_name, last_visit)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, channel_name) DO UPDATE SET last_visit = CURRENT_TIMESTAMP
  `).run(userId, channelName);
}

export async function countUnreadDmBySender(receiverId) {
  const rows = db.prepare(`
    SELECT sender_id, COUNT(*) as count 
    FROM messages 
    WHERE receiver_id = ? AND is_read = 0 AND channel_name IS NULL
    GROUP BY sender_id
  `).all(receiverId);
  
  const counts = {};
  rows.forEach(r => { counts[r.sender_id] = r.count; });
  return counts;
}

export async function countChannelUnread(userId, channelNames, workspaceId) {
  const res = {};
  const stmt = db.prepare(`
    SELECT COUNT(*) as count 
    FROM messages m
    LEFT JOIN channel_visits v ON v.user_id = ? AND v.channel_name = m.channel_name
    WHERE m.channel_name = ? AND m.workspace_id = ?
    AND (v.last_visit IS NULL OR m.timestamp > v.last_visit)
  `);
  
  for (const name of channelNames) {
    const row = stmt.get(userId, name, workspaceId);
    res[name] = row.count || 0;
  }
  return res;
}

// User & Auth mock helpers for SQLite
export async function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export async function listUsersByIds(ids) {
  if (!ids.length) return [];
  const markers = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM users WHERE id IN (${markers})`).all(...ids);
}

export async function upsertUser(u) {
  const stmt = db.prepare(`
    INSERT INTO users (id, email, name, profile_pic_url, role, team_name, team_role, workspace_id, is_restricted, dm_allowlist_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      profile_pic_url = excluded.profile_pic_url,
      role = excluded.role,
      team_name = excluded.team_name,
      team_role = excluded.team_role,
      workspace_id = excluded.workspace_id,
      is_restricted = excluded.is_restricted,
      dm_allowlist_only = excluded.dm_allowlist_only
  `);
  stmt.run(
    u.id,
    u.email || null,
    u.name || null,
    u.profile_pic_url || null,
    u.role || null,
    u.team_name || null,
    u.team_role || null,
    u.workspace_id || null,
    u.is_restricted ? 1 : 0,
    u.dm_allowlist_only ? 1 : 0
  );
}

export async function ensureUsersCached(ids, supabaseStore) {
  if (!ids.length) return [];
  const local = await listUsersByIds(ids);
  const localIds = new Set(local.map(u => u.id));
  const missingIds = ids.filter(id => !localIds.has(id));
  
  if (missingIds.length > 0) {
    const remote = await supabaseStore.listUsersByIds(missingIds);
    for (const u of remote) {
      await upsertUser(u);
    }
    const updated = await listUsersByIds(ids);
    return updated;
  }
  return local;
}
