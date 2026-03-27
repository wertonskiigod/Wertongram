const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

const Database = require('better-sqlite3');
const db = new Database('wertongramm.db');
db.pragma('foreign_keys = ON');

// Создание таблиц
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar TEXT,
    moons INTEGER DEFAULT 100,
    is_admin BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT CHECK(type IN ('direct', 'group')) NOT NULL,
    title TEXT,
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT,
    file_path TEXT,
    gift_id INTEGER,
    edited BOOLEAN DEFAULT 0,
    deleted BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

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

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
`);

// Добавляем стандартные подарки
const giftsList = [
  { name: '🌹 Роза', description: 'Классический подарок', price: 50, icon: '🌹' },
  { name: '🎁 Сюрприз', description: 'Загадочный подарок', price: 100, icon: '🎁' },
  { name: '💎 Алмаз', description: 'Редкий драгоценный камень', price: 500, icon: '💎' },
  { name: '🚀 Ракета', description: 'Для настоящих звёзд', price: 1000, icon: '🚀' },
  { name: '👑 Корона', description: 'Королевский подарок', price: 2000, icon: '👑' }
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

// Создаём системный канал "Новички"
const channelExists = db.prepare('SELECT id FROM chats WHERE title = ? AND type = ?').get('Новички', 'group');
let newbiesChannelId;
if (!channelExists) {
  const insertChannel = db.prepare('INSERT INTO chats (type, title) VALUES (?, ?)');
  const info = insertChannel.run('group', 'Новички');
  newbiesChannelId = info.lastInsertRowid;
  console.log('✅ Создан канал "Новички" с ID:', newbiesChannelId);
} else {
  newbiesChannelId = channelExists.id;
}

function addUserToNewbiesChannel(userId) {
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(newbiesChannelId, userId);
  if (!isMember) {
    db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)').run(newbiesChannelId, userId, 'member');
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    const welcomeText = `👋 Добро пожаловать, ${user.username || 'новый пользователь'}! Рады видеть вас в Wertongramm.`;
    db.prepare('INSERT INTO messages (chat_id, sender_id, text) VALUES (?, ?, ?)').run(newbiesChannelId, userId, welcomeText);
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

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// ==================== АУТЕНТИФИКАЦИЯ ====================

app.post('/api/register', async (req, res) => {
  const { phone, password, username, bio } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  
  // Проверка номера телефона (только цифры, 10-15 символов)
  const phoneRegex = /^[0-9]{10,15}$/;
  if (!phoneRegex.test(phone)) {
    return res.status(400).json({ error: 'Телефон должен содержать только цифры (10-15 символов)' });
  }
  
  try {
    const hashed = await bcrypt.hash(password, 10);
    // Админ по номеру телефона 1337228
    const isAdmin = (phone === '1337228') ? 1 : 0;
    const stmt = db.prepare('INSERT INTO users (phone, username, password_hash, is_admin, moons, bio) VALUES (?, ?, ?, ?, ?, ?)');
    const info = stmt.run(phone, username || null, hashed, isAdmin, 100, bio || '');
    
    addUserToNewbiesChannel(info.lastInsertRowid);
    
    const token = jwt.sign({ userId: info.lastInsertRowid }, JWT_SECRET);
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
  const token = jwt.sign({ userId: user.id }, JWT_SECRET);
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
  const user = db.prepare('SELECT id, phone, username, bio, moons, is_admin FROM users WHERE id = ?').get(req.userId);
  res.json(user);
});

app.get('/api/user/by-phone/:phone', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, bio, moons FROM users WHERE phone = ?').get(req.params.phone);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/user/:userId', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, bio, moons FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/user/update-bio', authenticate, (req, res) => {
  const { bio } = req.body;
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.userId);
  res.json({ success: true });
});

// Админ: выдача лун (только для номера 1337228)
app.post('/api/admin/add-moons', authenticate, requireAdmin, (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount) return res.status(400).json({ error: 'User ID and amount required' });
  db.prepare('UPDATE users SET moons = moons + ? WHERE id = ?').run(amount, userId);
  const user = db.prepare('SELECT id, username, moons FROM users WHERE id = ?').get(userId);
  io.emit('moons_updated', { userId: user.id, moons: user.moons });
  res.json({ success: true, user });
});

// ==================== API ПОДАРКОВ ====================

app.get('/api/gifts', authenticate, (req, res) => {
  const gifts = db.prepare('SELECT * FROM gifts ORDER BY price ASC').all();
  res.json(gifts);
});

// Получить полученные подарки (не конвертированные)
app.get('/api/my-gifts', authenticate, (req, res) => {
  const gifts = db.prepare(`
    SELECT ug.*, g.name, g.description, g.price, g.icon, u.username as from_username
    FROM user_gifts ug
    JOIN gifts g ON g.id = ug.gift_id
    LEFT JOIN users u ON u.id = ug.from_user_id
    WHERE ug.user_id = ? AND ug.is_converted = 0
    ORDER BY ug.created_at DESC
    LIMIT 50
  `).all(req.userId);
  res.json(gifts);
});

// Конвертировать подарок в луны
app.post('/api/convert-gift', authenticate, (req, res) => {
  const { giftId } = req.body;
  const gift = db.prepare('SELECT * FROM user_gifts WHERE id = ? AND user_id = ? AND is_converted = 0').get(giftId, req.userId);
  if (!gift) return res.status(404).json({ error: 'Gift not found' });
  
  const giftInfo = db.prepare('SELECT price FROM gifts WHERE id = ?').get(gift.gift_id);
  if (!giftInfo) return res.status(404).json({ error: 'Gift info not found' });
  
  db.prepare('UPDATE user_gifts SET is_converted = 1 WHERE id = ?').run(giftId);
  db.prepare('UPDATE users SET moons = moons + ? WHERE id = ?').run(giftInfo.price, req.userId);
  
  const user = db.prepare('SELECT moons FROM users WHERE id = ?').get(req.userId);
  io.emit('moons_updated', { userId: req.userId, moons: user.moons });
  
  res.json({ success: true, moons: user.moons });
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
  
  const newMessage = db.prepare(`SELECT m.*, u.username, g.name as gift_name, g.icon as gift_icon 
    FROM messages m 
    JOIN users u ON u.id = m.sender_id 
    LEFT JOIN gifts g ON g.id = m.gift_id
    WHERE m.id = ?`).get(message.lastInsertRowid);
  
  io.to(`chat:${chatId}`).emit('new_message', newMessage);
  io.emit('moons_updated', { userId: req.userId, moons: sender.moons - gift.price });
  
  res.json({ success: true });
});

// ==================== API ЧАТОВ ====================

app.get('/api/chats', authenticate, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.title, c.avatar,
           (SELECT json_group_array(json_object('userId', u.id, 'username', u.username))
            FROM chat_members cm2
            JOIN users u ON u.id = cm2.user_id
            WHERE cm2.chat_id = c.id) AS members
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
           (SELECT json_group_array(json_object('userId', u.id, 'username', u.username))
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
  const insertMember = db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)');
  insertMember.run(chatId, req.userId);
  insertMember.run(chatId, userId2);
  res.json({ id: chatId });
});

app.get('/api/messages/:chatId', authenticate, (req, res) => {
  const chatId = req.params.chatId;
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  const messages = db.prepare(`
    SELECT m.*, u.username, g.name as gift_name, g.icon as gift_icon
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN gifts g ON g.id = m.gift_id
    WHERE m.chat_id = ? AND m.deleted = 0
    ORDER BY m.created_at ASC
    LIMIT 100
  `).all(chatId);
  res.json(messages);
});

app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filePath: `/uploads/${req.file.filename}` });
});

app.use('/uploads', express.static(uploadDir));

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
  
  const userChats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.userId);
  for (const { chat_id } of userChats) {
    socket.join(`chat:${chat_id}`);
  }
  
  socket.on('send_message', (data) => {
    const { chatId, text, filePath } = data;
    const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, socket.userId);
    if (!isMember) return;
    const stmt = db.prepare('INSERT INTO messages (chat_id, sender_id, text, file_path) VALUES (?, ?, ?, ?)');
    const info = stmt.run(chatId, socket.userId, text, filePath || null);
    const newMessage = db.prepare(`
      SELECT m.*, u.username 
      FROM messages m 
      JOIN users u ON u.id = m.sender_id 
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
  
  socket.on('disconnect', () => {
    console.log(`🔌 User ${socket.userId} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
