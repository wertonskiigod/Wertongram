const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

// ==================== ПОСТОЯННОЕ ХРАНИЛИЩЕ ====================
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wertongramm.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const STICKERS_DIR = path.join(DATA_DIR, 'stickers');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
if (!fs.existsSync(STICKERS_DIR)) fs.mkdirSync(STICKERS_DIR, { recursive: true });

console.log('💾 Database path:', DB_PATH);
console.log('📁 Uploads path:', UPLOADS_DIR);
console.log('🖼️ Avatars path:', AVATARS_DIR);
console.log('🎨 Stickers path:', STICKERS_DIR);

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// ==================== СОЗДАНИЕ ТАБЛИЦ ====================
db.exec(`
  -- Пользователи
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE,
    first_name TEXT,
    last_name TEXT,
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar TEXT,
    moons INTEGER DEFAULT 100,
    is_admin BOOLEAN DEFAULT 0,
    is_online BOOLEAN DEFAULT 0,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Чаты
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT CHECK(type IN ('direct', 'group', 'channel', 'supergroup')) NOT NULL,
    title TEXT,
    avatar TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Участники чатов
  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    permissions TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Сообщения
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT,
    file_path TEXT,
    file_type TEXT,
    sticker_id INTEGER,
    gift_id INTEGER,
    reply_to INTEGER,
    is_forwarded BOOLEAN DEFAULT 0,
    forwarded_from INTEGER,
    edited BOOLEAN DEFAULT 0,
    pinned BOOLEAN DEFAULT 0,
    deleted BOOLEAN DEFAULT 0,
    views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (forwarded_from) REFERENCES users(id) ON DELETE SET NULL
  );

  -- Голосования
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    is_multiple BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    option_text TEXT NOT NULL,
    votes INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Стикеры
  CREATE TABLE IF NOT EXISTS sticker_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS stickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL,
    emoji TEXT,
    file_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (set_id) REFERENCES sticker_sets(id) ON DELETE CASCADE
  );

  -- Подарки
  CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL,
    icon TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gift_id INTEGER NOT NULL,
    from_user_id INTEGER,
    is_converted BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gift_id) REFERENCES gifts(id) ON DELETE CASCADE
  );

  -- Закреплённые сообщения
  CREATE TABLE IF NOT EXISTS pinned_messages (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  -- Чёрный список
  CREATE TABLE IF NOT EXISTS blocked_users (
    user_id INTEGER NOT NULL,
    blocked_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, blocked_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Контакты
  CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, contact_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Уведомления
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    from_user_id INTEGER,
    type TEXT NOT NULL,
    data TEXT,
    is_read BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
`);

// ==================== ДОБАВЛЕНИЕ ПОДАРКОВ ====================
const giftsList = [
  { name: '🌹 Роза', description: 'Классический подарок', price: 50, icon: '🌹' },
  { name: '🎁 Сюрприз', description: 'Загадочный подарок', price: 100, icon: '🎁' },
  { name: '💎 Алмаз', description: 'Редкий драгоценный камень', price: 500, icon: '💎' },
  { name: '🚀 Ракета', description: 'Для настоящих звёзд', price: 1000, icon: '🚀' },
  { name: '👑 Корона', description: 'Королевский подарок', price: 2000, icon: '👑' },
  { name: '🐱 Котик', description: 'Пушистый друг', price: 75, icon: '🐱' },
  { name: '🍕 Пицца', description: 'Вкусный подарок', price: 60, icon: '🍕' },
  { name: '🎮 Игра', description: 'Для геймеров', price: 150, icon: '🎮' },
  { name: '🎵 Музыка', description: 'Мелодичный подарок', price: 80, icon: '🎵' },
  { name: '📚 Книга', description: 'Для умных', price: 90, icon: '📚' },
  { name: '🏆 Трофей', description: 'Для победителей', price: 500, icon: '🏆' },
  { name: '💍 Кольцо', description: 'Для особенных', price: 1000, icon: '💍' }
];

const stmt = db.prepare('SELECT COUNT(*) as count FROM gifts');
const giftCount = stmt.get().count;
if (giftCount === 0) {
  const insert = db.prepare('INSERT INTO gifts (name, description, price, icon) VALUES (?, ?, ?, ?)');
  for (const gift of giftsList) {
    insert.run(gift.name, gift.description, gift.price, gift.icon);
  }
  console.log('✅ Добавлены стандартные подарки');
}

// ==================== ДОБАВЛЕНИЕ СТИКЕРОВ ====================
const defaultStickerSet = db.prepare('SELECT id FROM sticker_sets WHERE name = ?').get('default');
let defaultSetId;
if (!defaultStickerSet) {
  const insertSet = db.prepare('INSERT INTO sticker_sets (name, title) VALUES (?, ?)');
  const info = insertSet.run('default', 'Стандартные стикеры');
  defaultSetId = info.lastInsertRowid;
  
  const defaultStickers = [
    { emoji: '😀', file: '😀' },
    { emoji: '😂', file: '😂' },
    { emoji: '😍', file: '😍' },
    { emoji: '😎', file: '😎' },
    { emoji: '🥺', file: '🥺' },
    { emoji: '😡', file: '😡' },
    { emoji: '👍', file: '👍' },
    { emoji: '👎', file: '👎' },
    { emoji: '❤️', file: '❤️' },
    { emoji: '💔', file: '💔' }
  ];
  
  const insertSticker = db.prepare('INSERT INTO stickers (set_id, emoji, file_path) VALUES (?, ?, ?)');
  for (const sticker of defaultStickers) {
    insertSticker.run(defaultSetId, sticker.emoji, sticker.file);
  }
  console.log('✅ Добавлены стандартные стикеры');
} else {
  defaultSetId = defaultStickerSet.id;
}

// ==================== КАНАЛ "ИП Издаболы" ====================
const channelExists = db.prepare('SELECT id FROM chats WHERE title = ? AND type = ?').get('ИП Издаболы', 'supergroup');
let groupChannelId;
if (!channelExists) {
  const insertChannel = db.prepare('INSERT INTO chats (type, title, description) VALUES (?, ?, ?)');
  const info = insertChannel.run('supergroup', 'ИП Издаболы', 'Главный канал сообщества');
  groupChannelId = info.lastInsertRowid;
  console.log('✅ Создан супергруппа "ИП Издаболы" с ID:', groupChannelId);
} else {
  groupChannelId = channelExists.id;
}

function addUserToGroupChannel(userId) {
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(groupChannelId, userId);
  if (!isMember) {
    db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)').run(groupChannelId, userId, 'member');
    const user = db.prepare('SELECT username, first_name FROM users WHERE id = ?').get(userId);
    const welcomeText = `👋 Добро пожаловать в "ИП Издаболы", ${user.first_name || user.username || 'новый пользователь'}!`;
    db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)').run(groupChannelId, userId, welcomeText);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const JWT_SECRET = process.env.JWT_SECRET || 'wertongramm_secret_key';
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

// ==================== НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ ====================
function getFileType(filename, mimetype) {
  const imageExt = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
  const videoExt = /\.(mp4|webm|mov|avi|mkv)$/i;
  const audioExt = /\.(mp3|wav|ogg|m4a)$/i;
  
  if (imageExt.test(filename) || mimetype.startsWith('image/')) return 'image';
  if (videoExt.test(filename) || mimetype.startsWith('video/')) return 'video';
  if (audioExt.test(filename) || mimetype.startsWith('audio/')) return 'audio';
  return 'file';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (req.url.includes('/avatar')) cb(null, AVATARS_DIR);
    else if (req.url.includes('/sticker')) cb(null, STICKERS_DIR);
    else cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4',
    'application/pdf', 'text/plain', 'application/msword', 'application/zip'
  ];
  
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Неподдерживаемый тип файла'), false);
};

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: fileFilter
});

// ==================== АУТЕНТИФИКАЦИЯ ====================

app.post('/api/register', async (req, res) => {
  const { phone, password, first_name, last_name, username, bio } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  
  const phoneRegex = /^[0-9]{10,15}$/;
  if (!phoneRegex.test(phone)) {
    return res.status(400).json({ error: 'Телефон должен содержать только цифры (10-15 символов)' });
  }
  
  try {
    const hashed = await bcrypt.hash(password, 10);
    const isAdmin = (phone === '13372286752') ? 1 : 0;
    
    let finalUsername = username || phone;
    const existingTesy = db.prepare('SELECT id FROM users WHERE username = ?').get('Tesy');
    if (finalUsername === 'Tesy' && existingTesy) finalUsername = phone;
    
    const stmt = db.prepare('INSERT INTO users (phone, username, first_name, last_name, password_hash, is_admin, moons, bio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const info = stmt.run(phone, finalUsername, first_name || null, last_name || null, hashed, isAdmin, 100, bio || '');
    
    addUserToGroupChannel(info.lastInsertRowid);
    
    const token = jwt.sign({ userId: info.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: info.lastInsertRowid, isAdmin });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') return res.status(400).json({ error: 'Phone already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE phone = ? OR username = ?').get(phone, phone);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  
  db.prepare('UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, userId: user.id, isAdmin: user.is_admin === 1, moons: user.moons });
});

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.userId);
  if (!user || user.is_admin !== 1) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ==================== API ПОЛЬЗОВАТЕЛЕЙ ====================

app.get('/api/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, phone, username, first_name, last_name, bio, avatar, moons, is_admin FROM users WHERE id = ?').get(req.userId);
  res.json(user);
});

app.get('/api/user/:userId', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, first_name, last_name, bio, avatar, moons, is_online, last_seen FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/user/by-phone/:phone', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, first_name, last_name, avatar FROM users WHERE phone = ?').get(req.params.phone);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/user/update-profile', authenticate, (req, res) => {
  const { first_name, last_name, bio } = req.body;
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, bio = ? WHERE id = ?').run(first_name || null, last_name || null, bio || '', req.userId);
  res.json({ success: true });
});

app.post('/api/upload-avatar', authenticate, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const avatarUrl = `/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.userId);
  res.json({ success: true, avatarUrl });
});

app.post('/api/block-user', authenticate, (req, res) => {
  const { blockedUserId } = req.body;
  db.prepare('INSERT OR REPLACE INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)').run(req.userId, blockedUserId);
  res.json({ success: true });
});

app.post('/api/unblock-user', authenticate, (req, res) => {
  const { blockedUserId } = req.body;
  db.prepare('DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?').run(req.userId, blockedUserId);
  res.json({ success: true });
});

app.get('/api/blocked', authenticate, (req, res) => {
  const blocked = db.prepare(`
    SELECT u.id, u.username, u.first_name, u.last_name, u.avatar
    FROM blocked_users bu
    JOIN users u ON u.id = bu.blocked_user_id
    WHERE bu.user_id = ?
  `).all(req.userId);
  res.json(blocked);
});

app.post('/api/add-contact', authenticate, (req, res) => {
  const { contactId } = req.body;
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)').run(req.userId, contactId);
  res.json({ success: true });
});

app.get('/api/contacts', authenticate, (req, res) => {
  const contacts = db.prepare(`
    SELECT u.id, u.username, u.first_name, u.last_name, u.avatar, u.is_online
    FROM contacts c
    JOIN users u ON u.id = c.contact_id
    WHERE c.user_id = ?
  `).all(req.userId);
  res.json(contacts);
});

// ==================== API ЧАТОВ ====================

app.get('/api/chats', authenticate, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.title, c.avatar, c.description,
           (SELECT json_group_array(json_object('userId', u.id, 'username', u.username, 'first_name', u.first_name, 'last_name', u.last_name, 'avatar', u.avatar, 'role', cm.role))
            FROM chat_members cm2
            JOIN users u ON u.id = cm2.user_id
            WHERE cm2.chat_id = c.id) AS members,
           (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND deleted = 0 AND created_at > datetime('now', '-7 days')) as weekly_messages
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY (SELECT MAX(created_at) FROM messages WHERE chat_id = c.id) DESC
  `).all(req.userId);
  res.json(chats.map(c => ({ ...c, members: JSON.parse(c.members || '[]') })));
});

app.get('/api/chat/:chatId', authenticate, (req, res) => {
  const chat = db.prepare(`
    SELECT c.*, 
           (SELECT json_group_array(json_object('userId', u.id, 'username', u.username, 'first_name', u.first_name, 'last_name', u.last_name, 'avatar', u.avatar, 'role', cm.role))
            FROM chat_members cm
            JOIN users u ON u.id = cm.user_id
            WHERE cm.chat_id = c.id) AS members
    FROM chats c
    WHERE c.id = ?
  `).get(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.chatId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  chat.members = JSON.parse(chat.members || '[]');
  res.json(chat);
});

app.post('/api/chats/direct', authenticate, (req, res) => {
  const { userId2 } = req.body;
  if (userId2 == req.userId) return res.status(400).json({ error: 'Cannot chat with yourself' });
  
  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct'
  `).get(req.userId, userId2);
  if (existing) return res.json({ id: existing.id });
  
  const insertChat = db.prepare('INSERT INTO chats (type) VALUES (?)');
  const chatInfo = insertChat.run('direct');
  const chatId = chatInfo.lastInsertRowid;
  const insertMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)');
  insertMember.run(chatId, req.userId, 'member');
  insertMember.run(chatId, userId2, 'member');
  res.json({ id: chatId });
});

app.post('/api/chats/group', authenticate, (req, res) => {
  const { title, description, memberIds } = req.body;
  const insertChat = db.prepare('INSERT INTO chats (type, title, description) VALUES (?, ?, ?)');
  const chatInfo = insertChat.run('group', title, description || '');
  const chatId = chatInfo.lastInsertRowid;
  const insertMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)');
  insertMember.run(chatId, req.userId, 'owner');
  for (const userId of memberIds || []) {
    insertMember.run(chatId, userId, 'member');
  }
  res.json({ id: chatId });
});

app.post('/api/chats/update', authenticate, (req, res) => {
  const { chatId, title, description, avatar } = req.body;
  const isAdmin = db.prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.userId);
  if (!isAdmin || (isAdmin.role !== 'owner' && isAdmin.role !== 'admin')) {
    return res.status(403).json({ error: 'Not enough permissions' });
  }
  db.prepare('UPDATE chats SET title = COALESCE(?, title), description = COALESCE(?, description), avatar = COALESCE(?, avatar) WHERE id = ?')
    .run(title, description, avatar, chatId);
  res.json({ success: true });
});

app.post('/api/chats/leave', authenticate, (req, res) => {
  const { chatId } = req.body;
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, req.userId);
  res.json({ success: true });
});

// ==================== API СООБЩЕНИЙ ====================

app.get('/api/messages/:chatId', authenticate, (req, res) => {
  const chatId = req.params.chatId;
  const limit = req.query.limit || 100;
  const before = req.query.before;
  
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  
  let query = `
    SELECT m.*, u.username, u.first_name, u.last_name, u.avatar,
           g.name as gift_name, g.icon as gift_icon,
           s.emoji as sticker_emoji,
           p.question as poll_question,
           (SELECT COUNT(*) FROM poll_options WHERE poll_id = p.id) as poll_options_count
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN gifts g ON g.id = m.gift_id
    LEFT JOIN stickers s ON s.id = m.sticker_id
    LEFT JOIN polls p ON p.message_id = m.id
    WHERE m.chat_id = ? AND m.deleted = 0
  `;
  const params = [chatId];
  
  if (before) {
    query += ` AND m.id < ?`;
    params.push(before);
  }
  
  query += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(limit);
  
  const messages = db.prepare(query).all(params);
  res.json(messages.reverse());
});

app.post('/api/messages/send', authenticate, async (req, res) => {
  const { chatId, text, replyTo, filePath, fileType, stickerId, giftId } = req.body;
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  
  const stmt = db.prepare(`
    INSERT INTO messages (chat_id, sender_id, text, reply_to, file_path, file_type, sticker_id, gift_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(chatId, req.userId, text || null, replyTo || null, filePath || null, fileType || null, stickerId || null, giftId || null);
  
  const newMessage = db.prepare(`
    SELECT m.*, u.username, u.first_name, u.last_name, u.avatar,
           g.name as gift_name, g.icon as gift_icon,
           s.emoji as sticker_emoji
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN gifts g ON g.id = m.gift_id
    LEFT JOIN stickers s ON s.id = m.sticker_id
    WHERE m.id = ?
  `).get(info.lastInsertRowid);
  
  io.to(`chat:${chatId}`).emit('new_message', newMessage);
  res.json(newMessage);
});

app.post('/api/messages/edit', authenticate, (req, res) => {
  const { messageId, newText } = req.body;
  const msg = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
  if (!msg || msg.sender_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(newText, messageId);
  io.to(`chat:${msg.chat_id}`).emit('message_edited', { messageId, newText });
  res.json({ success: true });
});

app.post('/api/messages/delete', authenticate, (req, res) => {
  const { messageId } = req.body;
  const msg = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
  if (!msg || msg.sender_id !== req.userId) return res.status(403).json({ error: 'Not allowed' });
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
  io.to(`chat:${msg.chat_id}`).emit('message_deleted', { messageId });
  res.json({ success: true });
});

app.post('/api/messages/pin', authenticate, (req, res) => {
  const { chatId, messageId } = req.body;
  const isAdmin = db.prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.userId);
  if (!isAdmin || (isAdmin.role !== 'owner' && isAdmin.role !== 'admin')) {
    return res.status(403).json({ error: 'Not enough permissions' });
  }
  db.prepare('INSERT OR REPLACE INTO pinned_messages (chat_id, message_id) VALUES (?, ?)').run(chatId, messageId);
  io.to(`chat:${chatId}`).emit('message_pinned', { messageId });
  res.json({ success: true });
});

app.get('/api/messages/pinned/:chatId', authenticate, (req, res) => {
  const pinned = db.prepare(`
    SELECT m.*, u.username, u.first_name, u.last_name
    FROM pinned_messages pm
    JOIN messages m ON m.id = pm.message_id
    JOIN users u ON u.id = m.sender_id
    WHERE pm.chat_id = ?
  `).all(req.params.chatId);
  res.json(pinned);
});

// ==================== API ГОЛОСОВАНИЙ ====================

app.post('/api/polls/create', authenticate, (req, res) => {
  const { chatId, question, options, isMultiple } = req.body;
  
  const messageStmt = db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)');
  const messageInfo = messageStmt.run(chatId, req.userId, `📊 Опрос: ${question}`);
  
  const pollStmt = db.prepare('INSERT INTO polls (message_id, question, is_multiple) VALUES (?, ?, ?)');
  const pollInfo = pollStmt.run(messageInfo.lastInsertRowid, question, isMultiple ? 1 : 0);
  
  const optionStmt = db.prepare('INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)');
  for (const option of options) {
    optionStmt.run(pollInfo.lastInsertRowid, option);
  }
  
  const newMessage = db.prepare(`
    SELECT m.*, u.username, p.question as poll_question, p.is_multiple as poll_multiple
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN polls p ON p.message_id = m.id
    WHERE m.id = ?
  `).get(messageInfo.lastInsertRowid);
  
  io.to(`chat:${chatId}`).emit('new_message', newMessage);
  res.json(newMessage);
});

app.post('/api/polls/vote', authenticate, (req, res) => {
  const { pollId, optionId } = req.body;
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  
  const existingVote = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(pollId, req.userId);
  if (existingVote) {
    if (poll.is_multiple) {
      db.prepare('INSERT OR IGNORE INTO poll_votes (poll_id, user_id, option_id) VALUES (?, ?, ?)').run(pollId, req.userId, optionId);
    } else {
      return res.status(400).json({ error: 'Already voted' });
    }
  } else {
    db.prepare('INSERT INTO poll_votes (poll_id, user_id, option_id) VALUES (?, ?, ?)').run(pollId, req.userId, optionId);
  }
  
  db.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ?').run(optionId);
  
  io.to(`chat:poll_${pollId}`).emit('poll_updated', { pollId });
  res.json({ success: true });
});

app.get('/api/polls/:pollId', authenticate, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(req.params.pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  
  const options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ?').all(poll.id);
  const totalVotes = options.reduce((sum, opt) => sum + opt.votes, 0);
  
  const userVote = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, req.userId);
  
  res.json({ poll, options, totalVotes, userVote: userVote?.option_id });
});

// ==================== API СТИКЕРОВ ====================

app.get('/api/sticker-sets', authenticate, (req, res) => {
  const sets = db.prepare(`
    SELECT ss.*, (SELECT COUNT(*) FROM stickers WHERE set_id = ss.id) as stickers_count
    FROM sticker_sets ss
    ORDER BY ss.created_at DESC
  `).all();
  res.json(sets);
});

app.get('/api/stickers/:setId', authenticate, (req, res) => {
  const stickers = db.prepare('SELECT * FROM stickers WHERE set_id = ? ORDER BY id').all(req.params.setId);
  res.json(stickers);
});

app.post('/api/stickers/create-set', authenticate, (req, res) => {
  const { name, title } = req.body;
  const existing = db.prepare('SELECT id FROM sticker_sets WHERE name = ?').get(name);
  if (existing) return res.status(400).json({ error: 'Set name already exists' });
  
  const stmt = db.prepare('INSERT INTO sticker_sets (name, title, user_id) VALUES (?, ?, ?)');
  const info = stmt.run(name, title, req.userId);
  res.json({ id: info.lastInsertRowid });
});

app.post('/api/stickers/upload', authenticate, upload.single('sticker'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { set_id, emoji } = req.body;
  const filePath = `/stickers/${req.file.filename}`;
  const stmt = db.prepare('INSERT INTO stickers (set_id, emoji, file_path) VALUES (?, ?, ?)');
  const info = stmt.run(set_id, emoji || null, filePath);
  res.json({ id: info.lastInsertRowid, filePath });
});

// ==================== API ПОДАРКОВ ====================

app.get('/api/gifts', authenticate, (req, res) => {
  const gifts = db.prepare('SELECT * FROM gifts ORDER BY price ASC').all();
  res.json(gifts);
});

app.get('/api/user-gifts/:userId', authenticate, (req, res) => {
  const gifts = db.prepare(`
    SELECT ug.*, g.name, g.description, g.price, g.icon, u.username as from_username
    FROM user_gifts ug
    JOIN gifts g ON g.id = ug.gift_id
    LEFT JOIN users u ON u.id = ug.from_user_id
    WHERE ug.user_id = ? AND ug.is_converted = 0
    ORDER BY ug.created_at DESC
    LIMIT 50
  `).all(req.params.userId);
  res.json(gifts);
});

app.post('/api/send-gift', authenticate, (req, res) => {
  const { toUserId, giftId, chatId } = req.body;
  const sender = db.prepare('SELECT id, moons FROM users WHERE id = ?').get(req.userId);
  const gift = db.prepare('SELECT * FROM gifts WHERE id = ?').get(giftId);
  if (!gift) return res.status(404).json({ error: 'Gift not found' });
  if (sender.moons < gift.price) return res.status(400).json({ error: 'Not enough moons' });
  
  const toId = toUserId || (() => {
    const chat = db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id != ?').get(chatId, req.userId);
    return chat ? chat.user_id : null;
  })();
  if (!toId) return res.status(400).json({ error: 'Recipient not found' });
  
  db.prepare('UPDATE users SET moons = moons - ? WHERE id = ?').run(gift.price, req.userId);
  db.prepare('INSERT INTO user_gifts (user_id, gift_id, from_user_id, is_converted) VALUES (?, ?, ?, 0)').run(toId, giftId, req.userId);
  
  const message = db.prepare('INSERT INTO messages (chat_id, sender_id, text, gift_id) VALUES (?, ?, ?, ?)')
    .run(chatId, req.userId, `🎁 Подарил(а) ${gift.name} ${gift.icon}`, giftId);
  
  const newMessage = db.prepare(`
    SELECT m.*, u.username, u.first_name, u.last_name, g.name as gift_name, g.icon as gift_icon
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN gifts g ON g.id = m.gift_id
    WHERE m.id = ?
  `).get(message.lastInsertRowid);
  
  io.to(`chat:${chatId}`).emit('new_message', newMessage);
  io.emit('moons_updated', { userId: req.userId, moons: sender.moons - gift.price });
  res.json({ success: true });
});

app.post('/api/convert-gift', authenticate, (req, res) => {
  const { giftId } = req.body;
  const gift = db.prepare('SELECT * FROM user_gifts WHERE id = ? AND user_id = ? AND is_converted = 0').get(giftId, req.userId);
  if (!gift) return res.status(404).json({ error: 'Gift not found' });
  const giftInfo = db.prepare('SELECT price FROM gifts WHERE id = ?').get(gift.gift_id);
  db.prepare('UPDATE user_gifts SET is_converted = 1 WHERE id = ?').run(giftId);
  db.prepare('UPDATE users SET moons = moons + ? WHERE id = ?').run(giftInfo.price, req.userId);
  const user = db.prepare('SELECT moons FROM users WHERE id = ?').get(req.userId);
  io.emit('moons_updated', { userId: req.userId, moons: user.moons });
  res.json({ success: true, moons: user.moons });
});

// ==================== API УВЕДОМЛЕНИЙ ====================

app.get('/api/notifications', authenticate, (req, res) => {
  const notifications = db.prepare(`
    SELECT n.*, u.username, u.first_name, u.last_name, u.avatar
    FROM notifications n
    LEFT JOIN users u ON u.id = n.from_user_id
    WHERE n.user_id = ? AND n.is_read = 0
    ORDER BY n.created_at DESC
    LIMIT 50
  `).all(req.userId);
  res.json(notifications);
});

app.post('/api/notifications/mark-read', authenticate, (req, res) => {
  const { notificationId } = req.body;
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notificationId, req.userId);
  res.json({ success: true });
});

// ==================== API АДМИНА ====================

app.post('/api/admin/add-moons', authenticate, requireAdmin, (req, res) => {
  const { userId, amount } = req.body;
  db.prepare('UPDATE users SET moons = moons + ? WHERE id = ?').run(amount, userId);
  const user = db.prepare('SELECT id, username, moons FROM users WHERE id = ?').get(userId);
  io.emit('moons_updated', { userId: user.id, moons: user.moons });
  res.json({ success: true, user });
});

app.get('/api/admin/stats', authenticate, requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const totalChats = db.prepare('SELECT COUNT(*) as count FROM chats').get();
  const onlineUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_online = 1').get();
  res.json({ totalUsers, totalMessages, totalChats, onlineUsers });
});

// ==================== API ЗАГРУЗКИ ФАЙЛОВ ====================

app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `/uploads/${req.file.filename}`;
  const fileType = getFileType(req.file.filename, req.file.mimetype);
  res.json({ success: true, filePath: fileUrl, fileType, size: req.file.size });
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/avatars', express.static(AVATARS_DIR));
app.use('/stickers', express.static(STICKERS_DIR));

// ==================== SOCKET.IO ====================

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log(`🔌 User ${socket.userId} connected`);
  
  db.prepare('UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(socket.userId);
  io.emit('user_status', { userId: socket.userId, isOnline: true });
  
  const userChats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.userId);
  for (const { chat_id } of userChats) {
    socket.join(`chat:${chat_id}`);
  }
  
  socket.on('send_message', (data) => {
    const { chatId, text, replyTo, filePath, fileType, stickerId, giftId } = data;
    const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, socket.userId);
    if (!isMember) return;
    
    const stmt = db.prepare(`
      INSERT INTO messages (chat_id, sender_id, text, reply_to, file_path, file_type, sticker_id, gift_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(chatId, socket.userId, text || null, replyTo || null, filePath || null, fileType || null, stickerId || null, giftId || null);
    
    const newMessage = db.prepare(`
      SELECT m.*, u.username, u.first_name, u.last_name, u.avatar,
             g.name as gift_name, g.icon as gift_icon,
             s.emoji as sticker_emoji
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN gifts g ON g.id = m.gift_id
      LEFT JOIN stickers s ON s.id = m.sticker_id
      WHERE m.id = ?
    `).get(info.lastInsertRowid);
    
    io.to(`chat:${chatId}`).emit('new_message', newMessage);
  });
  
  socket.on('edit_message', ({ messageId, newText }) => {
    const msg = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.sender_id !== socket.userId) return;
    db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(newText, messageId);
    io.to(`chat:${msg.chat_id}`).emit('message_edited', { messageId, newText });
  });
  
  socket.on('delete_message', ({ messageId }) => {
    const msg = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.sender_id !== socket.userId) return;
    db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
    io.to(`chat:${msg.chat_id}`).emit('message_deleted', { messageId });
  });
  
  socket.on('typing', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('user_typing', { userId: socket.userId, chatId });
  });
  
  socket.on('read_messages', ({ chatId, messageId }) => {
    socket.to(`chat:${chatId}`).emit('messages_read', { userId: socket.userId, messageId });
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 User ${socket.userId} disconnected`);
    db.prepare('UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(socket.userId);
    io.emit('user_status', { userId: socket.userId, isOnline: false, lastSeen: new Date().toISOString() });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💾 Database stored at: ${DB_PATH}`);
  console.log(`📁 Uploads stored at: ${UPLOADS_DIR}`);
  console.log(`🖼️ Avatars stored at: ${AVATARS_DIR}`);
  console.log(`🎨 Stickers stored at: ${STICKERS_DIR}`);
});
