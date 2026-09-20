const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const path=require('path');
const admin=require('firebase-admin');
const {getCard,hasBingo}=require('./cartela');
const createBot=require('./telegramBot');

const serviceAccountJson=Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64||'','base64').toString('utf8');
if(!serviceAccountJson) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not set');
const serviceAccount=JSON.parse(serviceAccountJson);
if(!process.env.FIREBASE_DATABASE_URL) throw new Error('FIREBASE_DATABASE_URL is not set');
admin.initializeApp({credential:admin.credential.cert(serviceAccount),databaseURL:process.env.FIREBASE_DATABASE_URL});
const db=admin.database();
const app=express();
app.use(cors());app.use(express.json({limit:'100kb'}));
app.use(express.static(path.join(__dirname,'public')));

const BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
const BOT_USERNAME=String(process.env.TELEGRAM_BOT_USERNAME||'').replace(/^@/,'');
const MINI_APP_LINK_BASE=String(process.env.TELEGRAM_MINI_APP_LINK_BASE||'');
const ADMIN_UIDS=String(process.env.ADMIN_UIDS||'').split(',').map(x=>x.trim()).filter(Boolean);
const HOUSE_CUT=Math.min(Math.max(Number(process.env.HOUSE_CUT||0.20),0),1);
const CALL_INTERVAL_MS=Math.max(Number(process.env.CALL_INTERVAL_MS||3000),1000);
const ALLOWED_STAKES=new Set([10,20,50,100]);

const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const posInt=v=>{const n=num(v);return n!==null&&Number.isInteger(n)&&n>0?n:null;};
const money=v=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n<=1000000?Math.round(n*100)/100:null;};

async function profile(uid){if(typeof uid!=='string'||!/^tg_\d+$/.test(uid))return null;const s=await db.ref(`users/${uid}`).once('value');const p=s.val();return p&&String(p.telegramId)===uid.slice(3)?p:null;}
async function auth(req,res,next){const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):null;if(!token)return res.status(401).json({error:'Missing Authorization header'});try{const d=await admin.auth().verifyIdToken(token);const p=await profile(d.uid);if(!p)return res.status(403).json({error:'Telegram user verification required'});req.uid=d.uid;req.profile=p;next();}catch(e){console.error('auth:',e.message);res.status(401).json({error:'Invalid or expired token'});}}
function adminOnly(req,res,next){auth(req,res,()=>{if(!ADMIN_UIDS.includes(req.uid))return res.status(403).json({error:'Admin access required'});next();});}
function verifyTelegram(initData){if(!BOT_TOKEN)throw new Error('Bot token not configured');const p=new URLSearchParams(initData||'');const hash=p.get('hash');const authDate=Number(p.get('auth_date'));const userValue=p.get('user');if(!hash||!authDate||!userValue)throw new Error('Invalid Telegram WebApp data');p.delete('hash');const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();const computed=crypto.createHmac('sha256',secret).update(check).digest('hex');const a=Buffer.from(computed,'hex'),b=Buffer.from(hash,'hex');if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error('Invalid Telegram signature');const age=Date.now()/1000-authDate;if(!Number.isFinite(authDate)||age>300||age<-30)throw new Error('initData expired, reopen the app');let user;try{user=JSON.parse(userValue);}catch{throw new Error('Invalid Telegram user data');}if(!user||!user.id)throw new Error('Telegram user is required');return {user,startParam:p.get('start_param')||''};}
