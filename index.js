const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const path=require('path');
const admin=require('firebase-admin');
const {getCard,hasBingo}=require('./cartela');

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

app.get('/health',async(req,res)=>{try{const s=await db.ref('.info/connected').once('value').catch(()=>null);res.json({ok:true,service:'Beteseb Bingo',databaseConfigured:true,connected:s?s.val():null});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/verify-telegram-login',async(req,res)=>{try{const {user,startParam}=verifyTelegram(req.body.initData);const uid=`tg_${user.id}`;const userRef=db.ref(`users/${uid}`);const snap=await userRef.once('value');if(!snap.exists()){const code=String(user.id);await userRef.set({balance:0,referrals:0,cards:0,name:user.first_name||'Player',telegramId:user.id,referralCode:code,createdAt:admin.database.ServerValue.TIMESTAMP});await db.ref(`referralCodes/${code}`).set(uid);}
 const pSnap=await userRef.once('value');const p=pSnap.val()||{};
 // Referral is applied once, only for a new user and never to self.
 if(!snap.exists()&&startParam){const refSnap=await db.ref(`referralCodes/${String(startParam)}`).once('value');const refUid=refSnap.val();if(refUid&&refUid!==uid){await db.ref(`users/${refUid}/referrals`).transaction(v=>(Number(v)||0)+1);await userRef.update({referredBy:refUid});}}
 const balance=num((await userRef.child('balance').once('value')).val());const customToken=await admin.auth().createCustomToken(uid);res.json({customToken,uid,balance:balance===null?0:balance,referralCode:p.referralCode||String(user.id)});
 }catch(e){console.error('verify:',e);res.status(403).json({error:e.message});}});

app.get('/balance',auth,async(req,res)=>{try{let s=await db.ref(`users/${req.uid}/balance`).once('value');let b=num(s.val());if(b===null){await db.ref(`users/${req.uid}/balance`).set(0);b=0;}res.json({balance:b});}catch(e){console.error(e);res.status(500).json({error:'Could not load balance'});}});
app.get('/profile',auth,async(req,res)=>{const p=await profile(req.uid);res.json({name:p.name||'Player',telegramId:p.telegramId||req.uid.slice(3),referrals:Number(p.referrals||0),referralCode:p.referralCode||req.uid.slice(3),balance:Number(p.balance||0)});});
app.get('/referral',auth,async(req,res)=>{const p=await profile(req.uid);res.json({referralCode:p.referralCode||req.uid.slice(3),referrals:Number(p.referrals||0),botUsername:BOT_USERNAME,linkBase:MINI_APP_LINK_BASE});});
app.get('/history',auth,async(req,res)=>{try{const s=await db.ref(`users/${req.uid}/transactions`).orderByChild('createdAt').limitToLast(100).once('value');const raw=s.val()||{};const items=Object.entries(raw).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));res.json({items});}catch(e){res.status(500).json({error:'Could not load history'});}});

app.post('/deposit-request',auth,async(req,res)=>{try{const amount=money(req.body.amount);if(amount===null)return res.status(400).json({error:'Invalid deposit amount'});const id=db.ref('moneyRequests').push().key;const request={uid:req.uid,type:'deposit',amount,status:'pending',createdAt:admin.database.ServerValue.TIMESTAMP};const updates={};updates[`moneyRequests/${id}`]=request;updates[`users/${req.uid}/transactions/${id}`]=request;await db.ref().update(updates);res.json({requestId:id,status:'pending'});}catch(e){console.error(e);res.status(500).json({error:'Could not create deposit request'});}});
app.post('/withdrawal-request',auth,async(req,res)=>{try{const amount=money(req.body.amount);if(amount===null)return res.status(400).json({error:'Invalid withdrawal amount'});const balRef=db.ref(`users/${req.uid}/balance`);const tx=await balRef.transaction(v=>{const b=num(v);if(b===null||b<amount)return;return Math.round((b-amount)*100)/100;});if(!tx.committed)return res.status(412).json({error:'Insufficient balance'});const id=db.ref('moneyRequests').push().key;const request={uid:req.uid,type:'withdrawal',amount,status:'pending',createdAt:admin.database.ServerValue.TIMESTAMP};const updates={};updates[`moneyRequests/${id}`]=request;updates[`users/${req.uid}/transactions/${id}`]=request;try{await db.ref().update(updates);}catch(e){await balRef.transaction(v=>(num(v)||0)+amount);throw e;}res.json({requestId:id,status:'pending',balance:num(tx.snapshot.val())||0});}catch(e){console.error(e);res.status(500).json({error:'Could not create withdrawal request'});}});

app.post('/join-room',auth,async(req,res)=>{try{const stake=posInt(req.body.stake),cardNo=posInt(req.body.cartelaNumber);if(!ALLOWED_STAKES.has(stake))return res.status(400).json({error:'Invalid room stake'});if(cardNo===null||cardNo>500)return res.status(400).json({error:'Invalid cartela number'});const roomId=`stake_${stake}_open`,roomRef=db.ref(`rooms/${roomId}`),balRef=db.ref(`users/${req.uid}/balance`);
 const btx=await balRef.transaction(v=>{const b=num(v);if(b===null||b<stake)return;return Math.round((b-stake)*100)/100;});if(!btx.committed){const b=num(btx.snapshot.val());return res.status(412).json({error:b===null?'Balance unavailable. Please try again.':`Insufficient balance. You have ${b} ETB; ${stake} ETB is required.`});}
 const jtx=await roomRef.transaction(room=>{room=room||{stake,state:'waiting',players:{},taken:{}};if(room.state!=='waiting'||Number(room.stake)!==stake)return;room.players=room.players||{};room.taken=room.taken||{};if(room.players[req.uid])return; if(room.taken[String(cardNo)])return;room.players[req.uid]={cartelaNumber:cardNo,joinedAt:Date.now()};room.taken[String(cardNo)]=true;return room;});
 if(!jtx.committed){await balRef.transaction(v=>(num(v)||0)+stake);return res.status(409).json({error:'Cartela is already taken or the room has started.'});}
 let room=jtx.snapshot.val();const count=Object.keys(room.players||{}).length;if(count>=2){await roomRef.update({state:'running',startedAt:admin.database.ServerValue.TIMESTAMP,calledNumbers:{}});room=(await roomRef.once('value')).val();}
 const balance=num((await balRef.once('value')).val())||0;res.json({roomId,playerCount:Object.keys(room.players||{}).length,yourCard:getCard(cardNo),balance});
 }catch(e){console.error('join-room:',e);res.status(500).json({error:e.message||'Could not join room'});}});

app.post('/claim-bingo',auth,async(req,res)=>{try{const roomId=String(req.body.roomId||'');if(!/^stake_(10|20|50|100)_open$/.test(roomId))return res.status(400).json({error:'Invalid room'});const roomRef=db.ref(`rooms/${roomId}`);const snap=await roomRef.once('value');const room=snap.val();if(!room)return res.status(404).json({error:'Room not found'});if(room.state!=='running')return res.status(412).json({error:'Room not active'});const player=room.players&&room.players[req.uid];if(!player)return res.status(403).json({error:'You are not in this room'});const called=new Set(Object.keys(room.calledNumbers||{}).map(Number));if(!hasBingo(player.cartelaNumber,called))return res.status(412).json({error:'No BINGO on your card yet'});const count=Object.keys(room.players||{}).length;const gross=Number(room.stake)*count;const prize=Math.floor(gross*(1-HOUSE_CUT));const claimTx=await roomRef.transaction(r=>{if(!r||r.state!=='running'||!r.players||!r.players[req.uid])return;return {...r,state:'finished',winner:req.uid,prize,payoutStatus:'pending',finishedAt:Date.now()};});if(!claimTx.committed)return res.status(409).json({error:'This round has already been claimed.'});const payoutRef=db.ref(`users/${req.uid}/balance`);await payoutRef.transaction(v=>(num(v)||0)+prize);await roomRef.update({payoutStatus:'paid'});const txId=db.ref(`users/${req.uid}/transactions`).push().key;await db.ref(`users/${req.uid}/transactions/${txId}`).set({type:'win',amount:prize,roomId,status:'completed',createdAt:admin.database.ServerValue.TIMESTAMP});res.json({won:true,prize});}catch(e){console.error('claim:',e);res.status(500).json({error:'Could not process BINGO payout'});}});

app.get('/admin/money-requests',adminOnly,async(req,res)=>{try{const s=await db.ref('moneyRequests').orderByChild('createdAt').limitToLast(100).once('value');const raw=s.val()||{};const items=Object.entries(raw).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));res.json({items});}catch(e){res.status(500).json({error:'Could not load requests'});}});
async function processMoney(req,res,type,status){try{const id=String(req.params.id||'');const rRef=db.ref(`moneyRequests/${id}`);const snap=await rRef.once('value');const r=snap.val();if(!r)return res.status(404).json({error:'Request not found'});if(r.type!==type)return res.status(400).json({error:'Wrong request type'});if(r.status!=='pending')return res.status(409).json({error:'Request already processed'});
 if(type==='deposit'&&status==='approved'){await db.ref(`users/${r.uid}/balance`).transaction(v=>(num(v)||0)+Number(r.amount));}
 if(type==='withdrawal'&&status==='rejected'){await db.ref(`users/${r.uid}/balance`).transaction(v=>(num(v)||0)+Number(r.amount));}
 const now=admin.database.ServerValue.TIMESTAMP;const updates={};updates[`moneyRequests/${id}/status`]=status;updates[`moneyRequests/${id}/processedAt`]=now;updates[`moneyRequests/${id}/processedBy`]=req.uid;updates[`users/${r.uid}/transactions/${id}/status`]=status;updates[`users/${r.uid}/transactions/${id}/processedAt`]=now;updates[`users/${r.uid}/transactions/${id}/processedBy`]=req.uid;await db.ref().update(updates);res.json({ok:true,status,balance:num((await db.ref(`users/${r.uid}/balance`).once('value')).val())||0});}catch(e){console.error(e);res.status(500).json({error:'Could not process request'});}}
app.post('/admin/deposit/:id/approve',adminOnly,(req,res)=>processMoney(req,res,'deposit','approved'));
app.post('/admin/deposit/:id/reject',adminOnly,(req,res)=>processMoney(req,res,'deposit','rejected'));
app.post('/admin/withdrawal/:id/approve',adminOnly,(req,res)=>processMoney(req,res,'withdrawal','approved'));
app.post('/admin/withdrawal/:id/reject',adminOnly,(req,res)=>processMoney(req,res,'withdrawal','rejected'));

async function advanceAllRooms(){try{const s=await db.ref('rooms').orderByChild('state').equalTo('running').once('value');const rooms=s.val()||{};for(const [roomId,room] of Object.entries(rooms)){const called=new Set(Object.keys(room.calledNumbers||{}).map(Number));const remaining=[];for(let n=1;n<=75;n++)if(!called.has(n))remaining.push(n);if(!remaining.length){await db.ref(`rooms/${roomId}/state`).set('finished');continue;}const next=remaining[Math.floor(Math.random()*remaining.length)];await db.ref(`rooms/${roomId}/calledNumbers/${next}`).set(true);await db.ref(`rooms/${roomId}/lastCalled`).set(next);}}catch(e){console.error('advanceAllRooms:',e.message);}}
setInterval(advanceAllRooms,CALL_INTERVAL_MS);
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=Number(process.env.PORT||3000);app.listen(PORT,()=>console.log(`Beteseb Bingo listening on ${PORT}; Firebase project=${serviceAccount.project_id}`));
