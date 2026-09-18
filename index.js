const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const path=require('path');
const admin=require('firebase-admin');
const {Telegraf, Markup}=require('telegraf');
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

// Initialize Telegraf Bot for Main Menu Buttons & Commands
if(BOT_TOKEN){
    const bot = new Telegraf(BOT_TOKEN);
    
    bot.start(async (ctx) => {
        const userId = ctx.from.id;
        const uid = `tg_${userId}`;
        const startPayload = ctx.payload || '';
        
        const userRef = db.ref(`users/${uid}`);
        const snap = await userRef.once('value');
        
        if(!snap.exists()){
            const code = String(userId);
            await userRef.set({
                balance: 0,
                referrals: 0,
                cards: 0,
                hasDeposited: false,
                name: ctx.from.first_name || 'Player',
                telegramId: userId,
                referralCode: code,
                createdAt: admin.database.ServerValue.TIMESTAMP
            });
            await db.ref(`referralCodes/${code}`).set(uid);
            
            if(startPayload){
                const refSnap = await db.ref(`referralCodes/${String(startPayload)}`).once('value');
                const refUid = refSnap.val();
                if(refUid && refUid !== uid){
                    await db.ref(`users/${refUid}/referrals`).transaction(v => (Number(v)||0) + 1);
                    await db.ref(`users/${refUid}/cards`).transaction(v => (Number(v)||0) + 1);
                    await userRef.update({ referredBy: refUid });
                }
            }
        }
        
        const webAppUrl = MINI_APP_LINK_BASE || `https://t.me/${BOT_USERNAME}`;
        
        await ctx.reply(
            `👋 Welcome to Beteseb Bingo! Choose an Option below.`,
            Markup.inlineKeyboard([
                [Markup.button.webApp('🎮 Play', webAppUrl), Markup.button.callback('📝 Register', 'menu_register')],
                [Markup.button.callback('💰 Check Balance', 'menu_balance'), Markup.button.callback('💳 Deposit', 'menu_deposit')],
                [Markup.button.callback('📞 Contact Support', 'menu_support'), Markup.button.callback('📖 Instruction', 'menu_instruction')],
                [Markup.button.callback('🎁 Transfer', 'menu_transfer'), Markup.button.callback('💸 Withdraw', 'menu_withdraw')],
                [Markup.button.callback('👥 Invite', 'menu_invite'), Markup.button.callback('🔄 Convert Bonus', 'menu_convert')]
            ])
        );
    });

    bot.action('menu_register', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('📝 ለመመዝገብ ወይም መረጃዎን ለማየት ከላይ ያለውን የ "Play" ሚኒ አፕ ሊንክ ይጫኑ!');
    });

    bot.action('menu_balance', async (ctx) => {
        await ctx.answerCbQuery();
        const uid = `tg_${ctx.from.id}`;
        const s = await db.ref(`users/${uid}/balance`).once('value');
        const cardsSnap = await db.ref(`users/${uid}/cards`).once('value');
        const bal = s.val() || 0;
        const cards = cardsSnap.val() || 0;
        await ctx.reply(`💰 የእርስዎ ባላንስ: ${bal} ETB\n🎫 ነፃ ካርቴላዎች: ${cards}`);
    });

    bot.action('menu_deposit', async (ctx) => {
        await ctx.answerCbQuery();
        const teleNum = (await db.ref('settings/telebirrNumber').once('value')).val() || '+251914338110';
        const teleName = (await db.ref('settings/telebirrName').once('value')).val() || 'Mohammed Assefa';
        await ctx.reply(`💳 **የዲፖዚት መረጃ**\n\nእባክዎ ገንዘብ ያስተላልፉበት:\n📱 ቁጥር: ${teleNum}\n👤 ስም: ${teleName}\n\nከዚያም የሚኒ አፕ Wallet ገጽ በመክፈት የ Transaction ID ይላኩ።`, {parse_mode: 'Markdown'});
    });

    bot.action('menu_withdraw', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('💸 ገንዘብ ለማውጣት ሚኒ አፕ (Mini App) ውስጥ ወደ Wallet ገጽ በመሄድ Withdraw የሚለውን ቁልፍ ይጫኑ።');
    });

    bot.action('menu_invite', async (ctx) => {
        await ctx.answerCbQuery();
        const uid = `tg_${ctx.from.id}`;
        const pSnap = await db.ref(`users/${uid}`).once('value');
        const p = pSnap.val() || {};
        const code = p.referralCode || String(ctx.from.id);
        const link = MINI_APP_LINK_BASE ? `${MINI_APP_LINK_BASE}?startapp=${code}` : `https://t.me/${BOT_USERNAME}?startapp=${code}`;
        await ctx.reply(`👥 **የጓደኛ ማግበሪያ (Referral Link)**\n\nይህንን ሊንክ ለጓደኛዎ በመላክ 1 ነፃ ካርቴላ ይሸለሙ:\n${link}`);
    });

    bot.action(['menu_support', 'menu_instruction', 'menu_transfer', 'menu_convert'], async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('✨ ይህ አገልግሎት በሚኒ አፕ (Mini App) ውስጥ በቅርቡ ሙሉ በሙሉ ይስተካከላል!');
    });

    bot.launch().catch(e => console.log('Bot launch error:', e));
}

const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const posInt=v=>{const n=num(v);return n!==null&&Number.isInteger(n)&&n>0?n:null;};
const money=v=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n<=1000000?Math.round(n*100)/100:null;};

async function profile(uid){if(typeof uid!=='string'||!/^tg_\d+$/.test(uid))return null;const s=await db.ref(`users/${uid}`).once('value');const p=s.val();return p&&String(p.telegramId)===uid.slice(3)?p:null;}
async function auth(req,res,next){const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):null;if(!token)return res.status(401).json({error:'Missing Authorization header'});try{const d=await admin.auth().verifyIdToken(token);const p=await profile(d.uid);if(!p)return res.status(403).json({error:'Telegram user verification required'});req.uid=d.uid;req.profile=p;next();}catch(e){console.error('auth:',e.message);res.status(401).json({error:'Invalid or expired token'});}}
function adminOnly(req,res,next){auth(req,res,()=>{if(!ADMIN_UIDS.includes(req.uid))return res.status(403).json({error:'Admin access required'});next();});}

function verifyTelegram(initData){if(!BOT_TOKEN)throw new Error('Bot token not configured');const p=new URLSearchParams(initData||'');const hash=p.get('hash');const authDate=Number(p.get('auth_date'));const userValue=p.get('user');if(!hash||!authDate||!userValue)throw new Error('Invalid Telegram WebApp data');p.delete('hash');const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();const computed=crypto.createHmac('sha256',secret).update(check).digest('hex');const a=Buffer.from(computed,'hex'),b=Buffer.from(hash,'hex');if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error('Invalid Telegram signature');const age=Date.now()/1000-authDate;if(!Number.isFinite(authDate)||age>300||age<-30)throw new Error('initData expired, reopen the app');let user;try{user=JSON.parse(userValue);}catch{throw new Error('Invalid Telegram user data');}if(!user||!user.id)throw new Error('Telegram user is required');return {user,startParam:p.get('start_param')||''};}

app.get('/health',async(req,res)=>{try{const s=await db.ref('.info/connected').once('value').catch(()=>null);res.json({ok:true,service:'Beteseb Bingo',databaseConfigured:true,connected:s?s.val():null});}catch(e){res.status(500).json({ok:false,error:e.message});}});

app.post('/verify-telegram-login',async(req,res)=>{try{const {user,startParam}=verifyTelegram(req.body.initData);const uid=`tg_${user.id}`;const userRef=db.ref(`users/${uid}`);const snap=await userRef.once('value');if(!snap.exists()){const code=String(user.id);await userRef.set({balance:0,referrals:0,cards:0,hasDeposited:false,name:user.first_name||'Player',telegramId:user.id,referralCode:code,createdAt:admin.database.ServerValue.TIMESTAMP});await db.ref(`referralCodes/${code}`).set(uid);}
 const pSnap=await userRef.once('value');const p=pSnap.val()||{};
 if(!snap.exists()&&startParam){const refSnap=await db.ref(`referralCodes/${String(startParam)}`).once('value');const refUid=refSnap.val();if(refUid&&refUid!==uid){await db.ref(`users/${refUid}/referrals`).transaction(v=>(Number(v)||0)+1);await db.ref(`users/${refUid}/cards`).transaction(v=>(Number(v)||0)+1);await userRef.update({referredBy:refUid});}}
 const balance=num((await userRef.child('balance').once('value')).val());const freeCards=num((await userRef.child('cards').once('value')).val())||0;const customToken=await admin.auth().createCustomToken(uid);res.json({customToken,uid,balance:balance===null?0:balance,cards:freeCards,referralCode:p.referralCode||String(user.id)});
 }catch(e){console.error('verify:',e);res.status(403).json({error:e.message});}});

app.get('/balance',auth,async(req,res)=>{try{let s=await db.ref(`users/${req.uid}/balance`).once('value');let b=num(s.val());if(b===null){await db.ref(`users/${req.uid}/balance`).set(0);b=0;}let cSnap=await db.ref(`users/${req.uid}/cards`).once('value');let c=num(cSnap.val())||0;res.json({balance:b,cards:c});}catch(e){console.error(e);res.status(500).json({error:'Could not load balance'});}});
app.get('/profile',auth,async(req,res)=>{const p=await profile(req.uid);res.json({name:p.name||'Player',telegramId:p.telegramId||req.uid.slice(3),referrals:Number(p.referrals||0),cards:Number(p.cards||0),referralCode:p.referralCode||req.uid.slice(3),balance:Number(p.balance||0)});});
app.get('/referral',auth,async(req,res)=>{const p=await profile(req.uid);res.json({referralCode:p.referralCode||req.uid.slice(3),referrals:Number(p.referrals||0),cards:Number(p.cards||0),botUsername:BOT_USERNAME,linkBase:MINI_APP_LINK_BASE});});
app.get('/history',auth,async(req,res)=>{try{const s=await db.ref(`users/${req.uid}/transactions`).orderByChild('createdAt').limitToLast(100).once('value');const raw=s.val()||{};const items=Object.entries(raw).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));res.json({items});}catch(e){res.status(500).json({error:'Could not load history'});}});

app.get('/settings/telebirr', async (req, res) => {
    try {
        const snap = await db.ref('settings/telebirrNumber').once('value');
        const phone = snap.val() || '+251914338110';
        const name = (await db.ref('settings/telebirrName').once('value')).val() || 'Mohammed Assefa';
        res.json({ phone, name });
    } catch (e) {
        res.status(500).json({ error: 'Could not fetch settings' });
    }
});

app.post('/admin/settings/telebirr', adminOnly, async (req, res) => {
    try {
        const { phone, name } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone number is required' });
        await db.ref('settings').update({ telebirrNumber: phone, telebirrName: name || 'Mohammed Assefa' });
        res.json({ ok: true, phone, name });
    } catch (e) {
        res.status(500).json({ error: 'Could not update settings' });
    }
});

app.post('/deposit-request',auth,async(req,res)=>{
    try{
        const amount=money(req.body.amount);
        if(amount===null)return res.status(400).json({error:'Invalid deposit amount'});
        const transactionId=String(req.body.transactionId||'').trim();
        if(!transactionId)return res.status(400).json({error:'Transaction ID is required'});

        const txCheckSnap=await db.ref('usedTransactionIds').child(transactionId).once('value');
        if(txCheckSnap.exists()){
            return res.status(400).json({error:'ይህ የቴሌብር Transaction ID ከዚህ በፊት ጥቅም ላይ ውሏል!'});
        }

        const id=db.ref('moneyRequests').push().key;
        const request={uid:req.uid,type:'deposit',amount,transactionId,status:'pending',createdAt:admin.database.ServerValue.TIMESTAMP};
        const updates={};
        updates[`moneyRequests/${id}`]=request;
        updates[`users/${req.uid}/transactions/${id}`]=request;
        updates[`usedTransactionIds/${transactionId}`]=req.uid;

        await db.ref().update(updates);
        res.json({requestId:id,status:'pending'});
    }catch(e){console.error(e);res.status(500).json({error:'Could not create deposit request'});}
});

app.post('/withdrawal-request',auth,async(req,res)=>{try{const amount=money(req.body.amount);if(amount===null)return res.status(400).json({error:'Invalid withdrawal amount'});const balRef=db.ref(`users/${req.uid}/balance`);const tx=await balRef.transaction(v=>{const b=num(v);if(b===null||b<amount)return;return Math.round((b-amount)*100)/100;});if(!tx.committed)return res.status(412).json({error:'Insufficient balance'});const id=db.ref('moneyRequests').push().key;const request={uid:req.uid,type:'withdrawal',amount,status:'pending',createdAt:admin.database.ServerValue.TIMESTAMP};const updates={};updates[`moneyRequests/${id}`]=request;updates[`users/${req.uid}/transactions/${id}`]=request;try{await db.ref().update(updates);}catch(e){await balRef.transaction(v=>(num(v)||0)+amount);throw e;}res.json({requestId:id,status:'pending',balance:num(tx.snapshot.val())||0});}catch(e){console.error(e);res.status(500).json({error:'Could not create withdrawal request'});}});

app.post('/join-room',auth,async(req,res)=>{try{const stake=posInt(req.body.stake),cardNo=posInt(req.body.cartelaNumber);if(!ALLOWED_STAKES.has(stake))return res.status(400).json({error:'Invalid room stake'});if(cardNo===null||cardNo>500)return res.status(400).json({error:'Invalid cartela number'});const roomId=`stake_${stake}_open`,roomRef=db.ref(`rooms/${roomId}`),userRef=db.ref(`users/${req.uid}`),balRef=userRef.child('balance'),cardsRef=userRef.child('cards');
 
 let usedFreeCard=false;
 const ctx=await cardsRef.transaction(v=>{const c=num(v);if(c===null||c<=0)return;return c-1;});
 if(ctx.committed){
     usedFreeCard=true;
 }else{
     const btx=await balRef.transaction(v=>{const b=num(v);if(b===null||b<stake)return;return Math.round((b-stake)*100)/100;});
     if(!btx.committed){const b=num(btx.snapshot.val());return res.status(412).json({error:`Insufficient balance or free cards.`});}
 }

 const jtx=await roomRef.transaction(room=>{room=room||{stake,state:'waiting',players:{},taken:{}};if(room.state!=='waiting'||Number(room.stake)!==stake)return;room.players=room.players||{};room.taken=room.taken||{};if(room.players[req.uid])return; if(room.taken[String(cardNo)])return;room.players[req.uid]={cartelaNumber:cardNo,joinedAt:Date.now()};room.taken[String(cardNo)]=true;return room;});
 
 if(!jtx.committed){
     if(usedFreeCard){await cardsRef.transaction(v=>(num(v)||0)+1);}
     else{await balRef.transaction(v=>(num(v)||0)+stake);}
     return res.status(409).json({error:'Cartela is already taken or the room has started.'});
 }

 let room=jtx.snapshot.val();const count=Object.keys(room.players||{}).length;if(count>=2){await roomRef.update({state:'running',startedAt:admin.database.ServerValue.TIMESTAMP,calledNumbers:{}});room=(await roomRef.once('value')).val();}
 const balance=num((await balRef.once('value')).val())||0;const freeCardsLeft=num((await cardsRef.once('value')).val())||0;
 res.json({roomId,playerCount:Object.keys(room.players||{}).length,yourCard:getCard(cardNo),balance,cards:freeCardsLeft});
 }catch(e){console.error('join-room:',e);res.status(500).json({error:e.message||'Could not join room'});}});

app.get('/admin/money-requests',adminOnly,async(req,res)=>{try{const s=await db.ref('moneyRequests').orderByChild('createdAt').limitToLast(100).once('value');const raw=s.val()||{};const items=Object.entries(raw).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));res.json({items});}catch(e){res.status(500).json({error:'Could not load requests'});}});

async function processMoney(req,res,type,status){try{const id=String(req.params.id||'');const rRef=db.ref(`moneyRequests/${id}`);const snap=await rRef.once('value');const r=snap.val();if(!r)return res.status(404).json({error:'Request not found'});if(r.type!==type)return res.status(400).json({error:'Wrong request type'});if(r.status!=='pending')return res.status(409).json({error:'Request already processed'});
 
 if(type==='deposit'&&status==='approved'){
     const userRef=db.ref(`users/${r.uid}`);
     const userSnap=await userRef.once('value');
     const userData=userSnap.val()||{};
     let addAmount = Number(r.amount);
     let bonusAdded = false;

     if(!userData.hasDeposited){
         addAmount += 10;
         bonusAdded = true;
         await userRef.update({ hasDeposited: true });
     }

     await userRef.child('balance').transaction(v=>(num(v)||0)+addAmount);
     if(bonusAdded){
         const bonusTxId=db.ref(`users/${r.uid}/transactions`).push().key;
         await db.ref(`users/${r.uid}/transactions/${bonusTxId}`).set({type:'bonus',amount:10,status:'completed',createdAt:admin.database.ServerValue.TIMESTAMP});
     }
 }
 if(type==='deposit'&&status==='rejected'&&r.transactionId){
     await db.ref(`usedTransactionIds/${r.transactionId}`).remove();
 }
 if(type==='withdrawal'&&status==='rejected'){await db.ref(`users/${r.uid}/balance`).transaction(v=>(num(v)||0)+Number(r.amount));}
 const now=admin.database.ServerValue.TIMESTAMP;const updates={};updates[`moneyRequests/${id}/status`]=status;updates[`moneyRequests/${id}/processedAt`]=now;updates[`moneyRequests/${id}/processedBy`]=req.uid;updates[`users/${r.uid}/transactions/${id}/status`]=status;updates[`users/${r.uid}/transactions/${id}/processedAt`]=now;updates[`users/${r.uid}/transactions/${id}/processedBy`]=req.uid;await db.ref().update(updates);res.json({ok:true,status,balance:num((await db.ref(`users/${r.uid}/balance`).once('value')).val())||0});}catch(e){console.error(e);res.status(500).json({error:'Could not process request'});}}

app.post('/admin/deposit/:id/approve',adminOnly,(req,res)=>processMoney(req,res,'deposit','approved'));
app.post('/admin/deposit/:id/reject',adminOnly,(req,res)=>processMoney(req,res,'deposit','rejected'));
app.post('/admin/withdrawal/:id/approve',adminOnly,(req,res)=>processMoney(req,res,'withdrawal','approved'));
app.post('/admin/withdrawal/:id/reject',adminOnly,(req,res)=>processMoney(req,res,'withdrawal','rejected'));

function getBingoDisplay(n){
    if(n>=1 && n<=15) return `B ${n}`;
    if(n>=16 && n<=30) return `I ${n}`;
    if(n>=31 && n<=45) return `N ${n}`;
    if(n>=46 && n<=60) return `G ${n}`;
    if(n>=61 && n<=75) return `O ${n}`;
    return String(n);
}

async function advanceAllRooms(){
    try{
        const s=await db.ref('rooms').orderByChild('state').equalTo('running').once('value');
        const rooms=s.val()||{};
        for(const [roomId,room] of Object.entries(rooms)){
            const called=new Set(Object.keys(room.calledNumbers||{}).map(Number));
            const remaining=[];
            for(let n=1;n<=75;n++) if(!called.has(n)) remaining.push(n);
            if(!remaining.length){await db.ref(`rooms/${roomId}/state`).set('finished');continue;}
            const next=remaining[Math.floor(Math.random()*remaining.length)];
            const displayStr=getBingoDisplay(next);
            await db.ref(`rooms/${roomId}/calledNumbers/${next}`).set(true);
            await db.ref(`rooms/${roomId}/lastCalled`).set(next);
            await db.ref(`rooms/${roomId}/lastCalledDisplay`).set(displayStr);
            const players=room.players||{};
            let winnerUid=null;
            const newCalledSet=new Set([...called, next]);
            for(const [pUid, pData] of Object.entries(players)){
                const cardNo=pData.cartelaNumber;
                if(cardNo && hasBingo(cardNo, newCalledSet)){winnerUid=pUid;break;}
            }
            if(winnerUid){
                const count=Object.keys(players).length;
                const gross=Number(room.stake)*count;
                const prize=Math.floor(gross*(1-HOUSE_CUT));
                await db.ref(`rooms/${roomId}`).update({state:'finished',winner:winnerUid,prize,payoutStatus:'paid',finishedAt:Date.now()});
                await db.ref(`users/${winnerUid}/balance`).transaction(v=>(num(v)||0)+prize);
                const txId=db.ref(`users/${winnerUid}/transactions`).push().key;
                await db.ref(`users/${winnerUid}/transactions/${txId}`).set({type:'win',amount:prize,roomId,status:'completed',createdAt:admin.database.ServerValue.TIMESTAMP});
            }
        }
    }catch(e){console.error('advanceAllRooms:',e.message);}
}
setInterval(advanceAllRooms,CALL_INTERVAL_MS);

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=Number(process.env.PORT||3000);app.listen(PORT,()=>console.log(`Beteseb Bingo listening on ${PORT}`));
