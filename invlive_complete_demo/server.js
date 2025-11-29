require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const nodemailer = require('nodemailer');
const shortid = require('shortid');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default:fetch}) => fetch(...args));

const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);

async function initDb(){ await db.read(); db.data = db.data || { users:{}, transactions:{}, investments:{}, withdrawRequests:{}, settings:{} }; db.data.settings.adminEmail = db.data.settings.adminEmail || process.env.ADMIN_EMAIL || 'ops@example.com'; await db.write(); }
initDb();

const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.example.com', port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });

const app = express();
app.use(cors()); app.use(bodyParser.json());

function now(){ return Date.now(); }
async function save(){ await db.write(); }
async function getOrCreateUser(userId){ await db.read(); if(!db.data.users[userId]){ db.data.users[userId] = { id:userId, name:'Juxc Jay', balancesEUR:{ main:0, profit:0 }, transactions:[], investments:[] }; await save(); } return db.data.users[userId]; }

app.get('/api/ping', (req,res)=>res.json({ok:true, ts:now()}));

app.post('/api/transactions/deposit', async (req,res)=>{
  const { userId, amountEUR, method } = req.body;
  if(!userId || !amountEUR) return res.status(400).json({ ok:false, error:'missing fields' });
  await db.read();
  const user = await getOrCreateUser(userId);
  const txId = shortid.generate();
  const tx = { id: txId, userId, type:'deposit', amountEUR: Number(amountEUR), method: method||'BTC', status:'pending', createdAt: now() };
  db.data.transactions[txId] = tx; user.transactions.push(txId); await save();
  const payment = { method: tx.method };
  if(tx.method === 'BTC'){ try{ const btcResp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur'); const btcJson = await btcResp.json(); const priceEUR = btcJson.bitcoin.eur || 1; const amountBTC = Number((tx.amountEUR / priceEUR).toFixed(8)); payment.address = process.env.DEMO_BTC_ADDRESS || '1DemoBTCAddress111111111111111111'; payment.amountBTC = amountBTC; payment.uri = `bitcoin:${payment.address}?amount=${payment.amountBTC}`; }catch(e){ payment.error='btc error'; } } else { payment.instructions = 'Send bank transfer to account X. Use reference: ' + txId; }
  res.json({ ok:true, transaction: tx, payment });
});

app.post('/api/transactions/confirm', async (req,res)=>{ const { txId } = req.body; if(!txId) return res.status(400).json({ ok:false, error:'missing txId' }); await db.read(); const tx = db.data.transactions[txId]; if(!tx) return res.status(404).json({ ok:false, error:'tx not found' }); tx.status = 'success'; tx.confirmedAt = now(); const user = db.data.users[tx.userId]; if(user){ user.balancesEUR.main = (user.balancesEUR.main || 0) + tx.amountEUR; } await save(); res.json({ ok:true, tx }); });

app.post('/api/investments/create', async (req,res)=>{ const { userId, txId, planId } = req.body; if(!userId || !txId || !planId) return res.status(400).json({ ok:false, error:'missing fields' }); await db.read(); const tx = db.data.transactions[txId]; if(!tx || tx.userId !== userId) return res.status(400).json({ ok:false, error:'transaction not found or mismatch' }); if(tx.status !== 'success') return res.status(400).json({ ok:false, error:'transaction not confirmed' }); const invId = shortid.generate(); const inv = { id:invId, userId, txId, planId, amountEUR: tx.amountEUR, status:'active', createdAt: now() }; db.data.investments[invId] = inv; const user = db.data.users[userId]; user.investments.push(invId); user.balancesEUR.main = (user.balancesEUR.main || 0) - tx.amountEUR; await save(); res.json({ ok:true, inv }); });

app.get('/api/user/:userId/summary', async (req,res)=>{ const { userId } = req.params; await db.read(); const user = db.data.users[userId]; if(!user) return res.status(404).json({ ok:false, error:'user not found' }); const transactions = (user.transactions||[]).map(id => db.data.transactions[id]); const investments = (user.investments||[]).map(id => db.data.investments[id]); res.json({ ok:true, user, transactions, investments }); });

app.post('/api/withdraws/request', async (req,res)=>{ const { userId, amountEUR, toAddress } = req.body; if(!userId || !amountEUR) return res.status(400).json({ ok:false, error:'missing fields' }); await db.read(); const user = db.data.users[userId]; if(!user) return res.status(404).json({ ok:false, error:'user not found' }); const invs = (user.investments || []).map(id => db.data.investments[id]).filter(Boolean); const distinctPlans = new Set(invs.map(i=>i.planId)); if(invs.length < 5 || distinctPlans.size < 5){ return res.status(400).json({ ok:false, error:'withdraw_not_allowed', reason:'You must have at least 5 investments in different plans before withdrawal.' }); } const reqId = shortid.generate(); const wr = { id:reqId, userId, amountEUR: Number(amountEUR), to: toAddress || 'not specified', status:'pending', createdAt: now() }; db.data.withdrawRequests[reqId] = wr; await save(); const adminEmail = db.data.settings.adminEmail || process.env.ADMIN_EMAIL; if(adminEmail){ const mailOptions = { from: process.env.SMTP_FROM || 'no-reply@example.com', to: adminEmail, subject: `Withdraw request ${reqId} from ${userId}`, text: `User ${userId} requested withdrawal of ${wr.amountEUR} EUR. Request id: ${reqId} To: ${wr.to}`, html: `<p>User <b>${userId}</b> requested withdrawal of <b>${wr.amountEUR} EUR</b>.</p><p>Request id: ${reqId}</p><p>To: ${wr.to}</p>` }; try{ await transporter.sendMail(mailOptions); console.log('Admin email sent'); }catch(err){ console.warn('email failed', err.message); } } res.json({ ok:true, withdrawRequest: wr }); });

app.get('/api/admin/withdraws', async (req,res)=>{ await db.read(); const all = db.data.withdrawRequests || {}; const arr = Object.values(all).sort((a,b)=>b.createdAt - a.createdAt); res.json({ ok:true, withdraws: arr }); });

app.post('/api/withdraws/:id/approve', async (req,res)=>{ const id = req.params.id; await db.read(); const wr = db.data.withdrawRequests[id]; if(!wr) return res.status(404).json({ ok:false, error:'not found' }); wr.status = 'approved'; wr.approvedAt = now(); await save(); res.json({ ok:true, wr }); });

app.post('/api/withdraws/:id/reject', async (req,res)=>{ const id = req.params.id; await db.read(); const wr = db.data.withdrawRequests[id]; if(!wr) return res.status(404).json({ ok:false, error:'not found' }); wr.status = 'rejected'; wr.rejectedAt = now(); await save(); res.json({ ok:true, wr }); });

app.get('/db.json', async (req,res)=>{ if(fs.existsSync(dbFile)) return res.sendFile(dbFile); return res.status(404).send('no db'); });

const PORT = process.env.PORT || 4000; app.listen(PORT, ()=>console.log('Server running on', PORT));