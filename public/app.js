let socket;
let currentChatId = null;
let currentUser = null;

const authDiv = document.getElementById('auth');
const appDiv = document.getElementById('app');
const chatListDiv = document.getElementById('chatList');
const messagesContainer = document.getElementById('messagesContainer');
const chatHeader = document.getElementById('chatHeader');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const typingIndicator = document.getElementById('typingIndicator');
const currentUserSpan = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');
const createChatBtn = document.getElementById('createChatBtn');
const newChatPhone = document.getElementById('newChatPhone');

let typingTimeout = null;

// Сохранение токена
function setToken(token) {
    localStorage.setItem('token', token);
}

function getToken() {
    return localStorage.getItem('token');
}

function clearToken() {
    localStorage.removeItem('token');
}

// Аутентификация
document.getElementById('loginBtn').onclick = async () => {
    const phone = document.getElementById('phone').value;
    const password = document.getElementById('password').value;
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (res.ok) {
        setToken(data.token);
        currentUser = { id: data.userId };
        initApp();
    } else {
        alert(data.error);
    }
};

document.getElementById('registerBtn').onclick = async () => {
    const phone = document.getElementById('phone').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password, username })
    });
    const data = await res.json();
    if (res.ok) {
        setToken(data.token);
        currentUser = { id: data.userId };
        initApp();
    } else {
        alert(data.error);
    }
};

logoutBtn.onclick = () => {
    clearToken();
    if (socket) socket.disconnect();
    authDiv.style.display = 'block';
    appDiv.style.display = 'none';
};

// Инициализация после логина
async function initApp() {
    authDiv.style.display = 'none';
    appDiv.style.display = 'flex';
    await loadChats();
    connectSocket();
}

// Загрузка списка чатов
async function loadChats() {
    const token = getToken();
    const res = await fetch('/api/chats', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const chats = await res.json();
    renderChatList(chats);
}

function renderChatList(chats) {
    chatListDiv.innerHTML = '';
    for (const chat of chats) {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.dataset.chatId = chat.id;
        let title = chat.title;
        if (chat.type === 'direct') {
            const other = chat.members.find(m => m.userId != currentUser.id);
            title = other ? other.username || other.userId : 'Unknown';
        }
        div.textContent = title || `Chat ${chat.id}`;
        div.onclick = () => openChat(chat.id);
        chatListDiv.appendChild(div);
    }
}

async function openChat(chatId) {
    currentChatId = chatId;
    const token = getToken();
    const res = await fetch(`/api/messages/${chatId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const messages = await res.json();
    renderMessages(messages);
    const chatInfo = await fetch(`/api/chat/${chatId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const chat = await chatInfo.json();
    let title = chat.title;
    if (chat.type === 'direct') {
        const other = chat.members.find(m => m.userId != currentUser.id);
        title = other ? other.username || other.userId : 'Unknown';
    }
    chatHeader.textContent = title;
}

function renderMessages(messages) {
    messagesContainer.innerHTML = '';
    for (const msg of messages) {
        if (msg.deleted) {
            const div = document.createElement('div');
            div.className = 'message deleted';
            div.textContent = '[Deleted message]';
            messagesContainer.appendChild(div);
            continue;
        }
        const div = document.createElement('div');
        div.className = `message ${msg.sender_id === currentUser.id ? 'outgoing' : 'incoming'}`;
        div.dataset.id = msg.id;
        div.innerHTML = `
            <strong>${msg.username || msg.sender_id}</strong><br/>
            ${escapeHtml(msg.text || '')}
            ${msg.file_path ? `<br/><a href="${msg.file_path}" target="_blank">📎 File</a>` : ''}
            ${msg.edited ? '<span class="edited">(edited)</span>' : ''}
            <div class="message-actions">
                ${msg.sender_id === currentUser.id ? `<button class="edit-btn">Edit</button><button class="delete-btn">Delete</button>` : ''}
            </div>
        `;
        const editBtn = div.querySelector('.edit-btn');
        if (editBtn) editBtn.onclick = () => editMessage(msg.id, msg.text);
        const delBtn = div.querySelector('.delete-btn');
        if (delBtn) delBtn.onclick = () => deleteMessage(msg.id);
        messagesContainer.appendChild(div);
    }
    scrollToBottom();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function editMessage(messageId, oldText) {
    const newText = prompt('Edit message:', oldText);
    if (newText && newText !== oldText) {
        socket.emit('edit_message', { messageId, newText });
    }
}

function deleteMessage(messageId) {
    if (confirm('Delete this message?')) {
        socket.emit('delete_message', { messageId });
    }
}

sendBtn.onclick = async () => {
    if (!currentChatId) return;
    const text = messageInput.value.trim();
    if (!text) return;
    socket.emit('send_message', { chatId: currentChatId, text });
    messageInput.value = '';
};

attachBtn.onclick = () => fileInput.click();
fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    const token = getToken();
    const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
    });
    const data = await res.json();
    if (res.ok) {
        socket.emit('send_message', { chatId: currentChatId, text: '', filePath: data.filePath });
    } else {
        alert('Upload failed');
    }
    fileInput.value = '';
};

createChatBtn.onclick = async () => {
    const phone = newChatPhone.value.trim();
    if (!phone) return;
    const token = getToken();
    const res = await fetch(`/api/user/by-phone/${phone}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const user = await res.json();
    if (!user.id) return alert('User not found');
    const chatRes = await fetch('/api/chats/direct', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId2: user.id })
    });
    const chat = await chatRes.json();
    if (chat.id) {
        loadChats();
        openChat(chat.id);
    }
};

messageInput.addEventListener('input', () => {
    if (!currentChatId) return;
    socket.emit('typing', { chatId: currentChatId });
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        // Можно отправить событие остановки, но для простоты не будем
    }, 1000);
});

function connectSocket() {
    const token = getToken();
    socket = io({ auth: { token } });
    socket.on('connect', () => {
        console.log('Socket connected');
    });
    socket.on('new_message', (msg) => {
        if (currentChatId == msg.chat_id) {
            appendMessage(msg);
        }
        loadChats(); // обновляем список, чтобы чат поднялся вверх
    });
    socket.on('message_edited', ({ messageId, newText }) => {
        const msgDiv = messagesContainer.querySelector(`.message[data-id="${messageId}"]`);
        if (msgDiv) {
            const textNode = msgDiv.childNodes[2]; // после <strong><br/> может быть текст
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                textNode.textContent = newText;
            } else {
                // fallback: обновить innerHTML, но аккуратнее
                const strong = msgDiv.querySelector('strong');
                const next = strong.nextSibling;
                if (next && next.nodeType === Node.TEXT_NODE) next.textContent = newText;
            }
            if (!msgDiv.querySelector('.edited')) {
                const editedSpan = document.createElement('span');
                editedSpan.className = 'edited';
                editedSpan.textContent = '(edited)';
                msgDiv.appendChild(editedSpan);
            }
        }
    });
    socket.on('message_deleted', ({ messageId }) => {
        const msgDiv = messagesContainer.querySelector(`.message[data-id="${messageId}"]`);
        if (msgDiv) {
            msgDiv.innerHTML = '[Deleted message]';
            msgDiv.classList.add('deleted');
        }
    });
    socket.on('user_typing', ({ userId, chatId }) => {
        if (chatId === currentChatId && userId !== currentUser.id) {
            typingIndicator.textContent = 'Typing...';
            setTimeout(() => { typingIndicator.textContent = ''; }, 2000);
        }
    });
}

function appendMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.sender_id === currentUser.id ? 'outgoing' : 'incoming'}`;
    div.dataset.id = msg.id;
    div.innerHTML = `
        <strong>${msg.username || msg.sender_id}</strong><br/>
        ${escapeHtml(msg.text || '')}
        ${msg.file_path ? `<br/><a href="${msg.file_path}" target="_blank">📎 File</a>` : ''}
        ${msg.edited ? '<span class="edited">(edited)</span>' : ''}
        <div class="message-actions">
            ${msg.sender_id === currentUser.id ? `<button class="edit-btn">Edit</button><button class="delete-btn">Delete</button>` : ''}
        </div>
    `;
    const editBtn = div.querySelector('.edit-btn');
    if (editBtn) editBtn.onclick = () => editMessage(msg.id, msg.text);
    const delBtn = div.querySelector('.delete-btn');
    if (delBtn) delBtn.onclick = () => deleteMessage(msg.id);
    messagesContainer.appendChild(div);
    scrollToBottom();
}
