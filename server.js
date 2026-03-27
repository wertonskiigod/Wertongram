const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'wertongramm_secret_key_change_me';
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Создаём папку для загрузок, если её нет
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer для загрузки файлов
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// ===================== АУТЕНТИФИКАЦИЯ =====================

// Регистрация
app.post('/api/register', async (req, res) => {
  const { phone, password, username } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users (phone, username, password_hash) VALUES (?, ?, ?)');
    const info = stmt.run(phone, username || null, hashed);
    const token = jwt.sign({ userId: info.lastInsertRowid }, JWT_SECRET);
    res.json({ token, userId: info.lastInsertRowid });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'Phone already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Логин
app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  res.json({ token, userId: user.id });
});

// Middleware для проверки токена
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

// ===================== ПОЛЬЗОВАТЕЛИ =====================

// Найти пользователя по телефону
app.get('/api/user/by-phone/:phone', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, avatar FROM users WHERE phone = ?').get(req.params.phone);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ===================== ЧАТЫ =====================

// Список чатов пользователя
app.get('/api/chats', authenticate, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.title, c.avatar,
           (SELECT json_group_array(json_object('userId', u.id, 'username', u.username, 'avatar', u.avatar))
            FROM chat_members cm2
            JOIN users u ON u.id = cm2.user_id
            WHERE cm2.chat_id = c.id) AS members
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY (SELECT MAX(created_at) FROM messages WHERE chat_id = c.id) DESC
  `).all(req.userId);
  // Преобразуем members из JSON строки в объект
  res.json(chats.map(c => ({ ...c, members: JSON.parse(c.members || '[]') })));
});

// Информация о чате
app.get('/api/chat/:chatId', authenticate, (req, res) => {
  const chat = db.prepare(`
    SELECT c.*, 
           (SELECT json_group_array(json_object('userId', u.id, 'username', u.username, 'avatar', u.avatar))
            FROM chat_members cm
            JOIN users u ON u.id = cm.user_id
            WHERE cm.chat_id = c.id) AS members
    FROM chats c
    WHERE c.id = ?
  `).get(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  // Проверка, что пользователь состоит в чате
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(req.params.chatId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  chat.members = JSON.parse(chat.members || '[]');
  res.json(chat);
});

// Создание личного чата
app.post('/api/chats/direct', authenticate, (req, res) => {
  const { userId2 } = req.body;
  if (userId2 == req.userId) return res.status(400).json({ error: 'Cannot chat with yourself' });
  // Проверяем, существует ли уже директ
  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct'
  `).get(req.userId, userId2);
  if (existing) return res.json({ id: existing.id });
  // Создаём новый чат
  const insertChat = db.prepare('INSERT INTO chats (type) VALUES (?)');
  const chatInfo = insertChat.run('direct');
  const chatId = chatInfo.lastInsertRowid;
  const insertMember = db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)');
  insertMember.run(chatId, req.userId);
  insertMember.run(chatId, userId2);
  res.json({ id: chatId });
});

// ===================== СООБЩЕНИЯ =====================

// Получить сообщения чата
app.get('/api/messages/:chatId', authenticate, (req, res) => {
  const chatId = req.params.chatId;
  const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });
  const messages = db.prepare(`
    SELECT m.*, u.username, u.avatar
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? AND m.deleted = 0
    ORDER BY m.created_at ASC
    LIMIT 100
  `).all(chatId);
  res.json(messages);
});

// ===================== ФАЙЛЫ =====================

// Загрузка файла
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filePath: `/uploads/${req.file.filename}` });
});

// Раздача загруженных файлов
app.use('/uploads', express.static(uploadDir));

// ===================== SOCKET.IO =====================

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
  console.log(`User ${socket.userId} connected`);

  // Присоединение к комнатам чатов
  const userChats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.userId);
  for (const { chat_id } of userChats) {
    socket.join(`chat:${chat_id}`);
  }

  // Отправка сообщения
  socket.on('send_message', (data) => {
    const { chatId, text, replyTo, filePath } = data;
    const isMember = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, socket.userId);
    if (!isMember) return;
    const stmt = db.prepare(`
      INSERT INTO messages (chat_id, sender_id, text, file_path, reply_to)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(chatId, socket.userId, text, filePath || null, replyTo || null);
    const newMessage = db.prepare(`
      SELECT m.*, u.username, u.avatar
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `).get(info.lastInsertRowid);
    io.to(`chat:${chatId}`).emit('new_message', newMessage);
  });

  // Редактирование сообщения
  socket.on('edit_message', ({ messageId, newText }) => {
    const msg = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.sender_id !== socket.userId) return;
    db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(newText, messageId);
    io.to(`chat:${msg.chat_id}`).emit('message_edited', { messageId, newText });
  });

  // Удаление сообщения (мягкое удаление)
  socket.on('delete_message', ({ messageId }) => {
    const msg = db.prepare('SELECT chat_id, sender_id FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.sender_id !== socket.userId) return;
    db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
    io.to(`chat:${msg.chat_id}`).emit('message_deleted', { messageId });
  });

  // Набор текста
  socket.on('typing', ({ chatId }) => {
    socket.to(`chat:${chatId}`).emit('user_typing', { userId: socket.userId, chatId });
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.userId} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});