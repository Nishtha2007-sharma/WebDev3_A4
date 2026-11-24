const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "chat-data.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], messages: [] }, null, 2));

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { users: [], messages: [] }; }
}
let db = loadDB();
function saveDB() {
  const temp = DB_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}
const sessions = new Map();
const onlineSockets = new Map();
const typingByUser = new Map();
const publicUser = u => ({ id: u.id, username: u.username, createdAt: u.createdAt });
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const userId = sessions.get(token);
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: "Please log in again." });
  req.user = user; next();
}
function conversationHas(a, b, m) {
  return (m.senderId === a && m.recipientId === b) || (m.senderId === b && m.recipientId === a);
}
function conversationRoom(a,b) { return ["chat", ...[a,b].sort()].join(":"); }

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));
app.get("/api/health", (_req,res) => res.json({ ok:true, service:"bestie chat", users:db.users.length }));
app.post("/api/auth/register", (req,res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({error:"Username must be 3–20 characters (letters, numbers or underscore)."});
  if (password.length < 6 || password.length > 100) return res.status(400).json({error:"Password must be at least 6 characters."});
  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({error:"That username is already taken."});
  const salt = crypto.randomBytes(16).toString("hex");
  const user = { id:crypto.randomUUID(), username, salt, passwordHash:hashPassword(password,salt), createdAt:new Date().toISOString() };
  db.users.push(user); saveDB();
  const token = crypto.randomBytes(32).toString("hex"); sessions.set(token,user.id);
  res.status(201).json({token,user:publicUser(user)});
});
app.post("/api/auth/login", (req,res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || hashPassword(password,user.salt) !== user.passwordHash) return res.status(401).json({error:"Incorrect username or password."});
  const token = crypto.randomBytes(32).toString("hex"); sessions.set(token,user.id);
  res.json({token,user:publicUser(user)});
});
app.get("/api/auth/me",auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.post("/api/auth/logout",auth,(req,res)=>{const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");sessions.delete(token);res.json({ok:true});});
app.get("/api/users",auth,(req,res)=>{
  const users=db.users.filter(u=>u.id!==req.user.id).map(u=>{
    const msgs=db.messages.filter(m=>conversationHas(req.user.id,u.id,m)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const unread=msgs.filter(m=>m.recipientId===req.user.id&&!m.readAt).length;
    return {...publicUser(u),online:(onlineSockets.get(u.id)?.size||0)>0,unread,lastMessage:msgs[0]?.text||""};
  }).sort((a,b)=>(b.online-a.online)||b.lastMessage.localeCompare(a.lastMessage));
  res.json({users});
});
app.get("/api/messages/:userId",auth,(req,res)=>{
  const other=db.users.find(u=>u.id===req.params.userId);
  if(!other||other.id===req.user.id)return res.status(404).json({error:"Friend not found."});
  const messages=db.messages.filter(m=>conversationHas(req.user.id,other.id,m)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  res.json({messages});
});

io.use((socket,next)=>{
  const token=socket.handshake.auth?.token;
  const userId=sessions.get(token);
  const user=db.users.find(u=>u.id===userId);
  if(!user)return next(new Error("Authentication required"));
  socket.user=user; next();
});
io.on("connection",socket=>{
  const user=socket.user;
  socket.join("user:"+user.id);
  if(!onlineSockets.has(user.id))onlineSockets.set(user.id,new Set());
  onlineSockets.get(user.id).add(socket.id);
  socket.broadcast.emit("presence",{userId:user.id,online:true});

  socket.on("joinChat",({userId}={})=>{
    const friend=db.users.find(u=>u.id===userId);
    if(!friend||friend.id===user.id)return;
    socket.join(conversationRoom(user.id,friend.id));
  });
  socket.on("message:send",(payload={},ack=()=>{})=>{
    const to=db.users.find(u=>u.id===payload.to);
    const text=String(payload.text||"").trim();
    if(!to||to.id===user.id)return ack({error:"Choose a valid friend."});
    if(!text||text.length>2000)return ack({error:"Message must be 1–2000 characters."});
    const message={id:crypto.randomUUID(),senderId:user.id,recipientId:to.id,text,createdAt:new Date().toISOString(),readAt:null};
    db.messages.push(message);saveDB();
    const room=conversationRoom(user.id,to.id);
    io.to("user:"+user.id).emit("message:new",message);
    io.to("user:"+to.id).emit("message:new",message);
    ack({ok:true,messageId:message.id});
  });
  socket.on("typing",({to,isTyping}={})=>{
    const friend=db.users.find(u=>u.id===to);if(!friend)return;
    socket.to("user:"+friend.id).emit("typing",{userId:user.id,isTyping:!!isTyping});
  });
  socket.on("markRead",({userId}={})=>{
    const friend=db.users.find(u=>u.id===userId);if(!friend)return;
    let changed=false;const now=new Date().toISOString();
    for(const m of db.messages){if(m.senderId===friend.id&&m.recipientId===user.id&&!m.readAt){m.readAt=now;changed=true;}}
    if(changed)saveDB();
    io.to("user:"+friend.id).emit("message:read",{readerId:user.id});
  });
  socket.on("disconnect",()=>{
    const set=onlineSockets.get(user.id);if(set){set.delete(socket.id);if(!set.size){onlineSockets.delete(user.id);socket.broadcast.emit("presence",{userId:user.id,online:false});}}
  });
});

httpServer.listen(PORT,()=>console.log(`Bestie Chat server running at http://localhost:${PORT}`));
