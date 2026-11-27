const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function txCode(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

function required(body, fields) {
  return fields.every(f => String(body?.[f] ?? "").trim() !== "");
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(20) UNIQUE NOT NULL,
      display_name VARCHAR(80) NOT NULL,
      password_hash TEXT NOT NULL,
      balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      pix_key VARCHAR(120) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(20) NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      description VARCHAR(160) NOT NULL,
      counterparty VARCHAR(120),
      tx_code VARCHAR(120) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message VARCHAR(240) NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await seedUser("bruno", "Bruno", "Bruno*1902", 1250, "bruno@fictibank");
  await seedUser("irmao", "Irmão", "4321", 650, "irmao@fictibank");
}

async function seedUser(username, displayName, password, initialBalance, pixKey) {
  const existing = await pool.query(
    "SELECT id FROM users WHERE username=$1 OR pix_key=$2 LIMIT 1",
    [username, pixKey]
  );
  if (existing.rowCount) return;

  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO users (username, display_name, password_hash, balance, pix_key)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name, balance, pix_key`,
      [username, displayName, hash, initialBalance, pixKey]
    );
    const userId = r.rows[0].id;

    if (initialBalance > 0) {
      await client.query(
        `INSERT INTO transactions
         (user_id,type,amount,description,counterparty,tx_code)
         VALUES ($1,'deposit',$2,'Saldo inicial','FictiBank',$3)`,
        [userId, initialBalance, txCode("INIT")]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

app.get("/api/ping", async (req,res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, message: "FictiBank online" });
  } catch {
    res.status(500).json({ ok:false, error:"Banco indisponível." });
  }
});

app.post("/api/register", async (req,res) => {
  try {
    if (!required(req.body, ["username","password","displayName"])) {
      return res.status(400).json({ error:"Preencha usuário, senha e nome." });
    }

    const username = String(req.body.username).trim().toLowerCase();
    const password = String(req.body.password);
    const displayName = String(req.body.displayName).trim();

    if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
      return res.status(400).json({ error:"Usuário deve ter 3 a 20 caracteres: letras, números, ponto, _ ou -." });
    }
    if (password.length < 4) {
      return res.status(400).json({ error:"A senha precisa ter pelo menos 4 caracteres." });
    }
    if (displayName.length < 2) {
      return res.status(400).json({ error:"Digite um nome válido." });
    }

    const pixKey = `${username}@fictibank`;
    const hash = await bcrypt.hash(password, 10);

    const r = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, balance, pix_key)
       VALUES ($1,$2,$3,0,$4)
       RETURNING id, username, display_name, balance, pix_key`,
      [username, displayName, hash, pixKey]
    );

    res.status(201).json({ user: r.rows[0] });
  } catch (e) {
    console.error("REGISTER:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error:"Esse usuário ou chave Pix já existe." });
    }
    res.status(500).json({ error:"Não foi possível criar a conta." });
  }
});

app.post("/api/login", async (req,res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const r = await pool.query(
      "SELECT id,username,display_name,balance,pix_key,password_hash FROM users WHERE username=$1",
      [username]
    );
    if (!r.rowCount) return res.status(401).json({ error:"Usuário ou senha incorretos." });

    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error:"Usuário ou senha incorretos." });

    delete user.password_hash;
    res.json({ user });
  } catch (e) {
    console.error("LOGIN:", e);
    res.status(500).json({ error:"Não foi possível fazer login." });
  }
});

app.get("/api/account/:id", async (req,res) => {
  try {
    const user = await pool.query(
      "SELECT id,username,display_name,balance,pix_key,created_at FROM users WHERE id=$1",
      [req.params.id]
    );
    if (!user.rowCount) return res.status(404).json({ error:"Conta não encontrada." });

    const tx = await pool.query(
      `SELECT id,type,amount,description,counterparty,tx_code,created_at
       FROM transactions WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 100`,
      [req.params.id]
    );

    const notifications = await pool.query(
      `SELECT id,message,read,created_at
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );

    res.json({ user:user.rows[0], transactions:tx.rows, notifications:notifications.rows });
  } catch (e) {
    console.error("ACCOUNT:", e);
    res.status(500).json({ error:"Não foi possível carregar a conta." });
  }
});

app.get("/api/users", async (req,res) => {
  try {
    const r = await pool.query(
      "SELECT id,username,display_name,balance,pix_key FROM users ORDER BY display_name"
    );
    res.json({ users:r.rows });
  } catch (e) {
    res.status(500).json({ error:"Não foi possível listar usuários." });
  }
});

app.post("/api/add-money", async (req,res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.body?.userId);
    const amount = money(req.body?.amount);

    if (!Number.isInteger(userId) || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error:"Valor inválido." });
    }

    await client.query("BEGIN");

    const r = await client.query(
      "UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING id,username,display_name,balance,pix_key",
      [amount, userId]
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"Conta não encontrada." });
    }

    await client.query(
      `INSERT INTO transactions
       (user_id,type,amount,description,counterparty,tx_code)
       VALUES ($1,'deposit',$2,'Dinheiro adicionado','FictiBank',$3)`,
      [userId, amount, txCode("DEP")]
    );

    await client.query("COMMIT");
    res.json({ user:r.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("ADD MONEY:", e);
    res.status(500).json({ error:"Não foi possível adicionar dinheiro." });
  } finally {
    client.release();
  }
});

app.post("/api/pix", async (req,res) => {
  const client = await pool.connect();
  try {
    const senderId = Number(req.body?.senderId);
    const receiverKey = String(req.body?.receiverPixKey || "").trim().toLowerCase();
    const amount = money(req.body?.amount);

    if (!Number.isInteger(senderId) || !receiverKey || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error:"Dados do Pix inválidos." });
    }

    await client.query("BEGIN");

    const sender = await client.query(
      "SELECT id,display_name,balance,pix_key FROM users WHERE id=$1 FOR UPDATE",
      [senderId]
    );
    const receiver = await client.query(
      "SELECT id,display_name,balance,pix_key FROM users WHERE pix_key=$1 FOR UPDATE",
      [receiverKey]
    );

    if (!sender.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"Conta de origem não encontrada." });
    }
    if (!receiver.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"Chave Pix não encontrada." });
    }
    if (sender.rows[0].id === receiver.rows[0].id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"Você não pode enviar Pix para a própria conta." });
    }
    if (Number(sender.rows[0].balance) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error:"Saldo insuficiente." });
    }

    await client.query(
      "UPDATE users SET balance=balance-$1 WHERE id=$2",
      [amount, senderId]
    );
    await client.query(
      "UPDATE users SET balance=balance+$1 WHERE id=$2",
      [amount, receiver.rows[0].id]
    );

    const code = txCode("PIX");

    await client.query(
      `INSERT INTO transactions
       (user_id,type,amount,description,counterparty,tx_code)
       VALUES ($1,'pix_sent',$2,$3,$4,$5)`,
      [senderId, -amount, `Pix enviado para ${receiver.rows[0].display_name}`, receiver.rows[0].pix_key, code]
    );

    await client.query(
      `INSERT INTO transactions
       (user_id,type,amount,description,counterparty,tx_code)
       VALUES ($1,'pix_received',$2,$3,$4,$5)`,
      [receiver.rows[0].id, amount, `Pix recebido de ${sender.rows[0].display_name}`, sender.rows[0].pix_key, `${code}-R`]
    );

    await client.query(
      `INSERT INTO notifications (user_id,message)
       VALUES ($1,$2)`,
      [receiver.rows[0].id, `Você recebeu um Pix de ${sender.rows[0].display_name} no valor de R$ ${amount.toFixed(2).replace(".",",")}.`]
    );

    await client.query("COMMIT");

    const updated = await pool.query(
      "SELECT id,username,display_name,balance,pix_key FROM users WHERE id=$1",
      [senderId]
    );

    res.json({
      ok:true,
      user:updated.rows[0],
      txCode:code,
      receipt:{
        code,
        amount,
        from:sender.rows[0].pix_key,
        to:receiver.rows[0].pix_key,
        receiverName:receiver.rows[0].display_name,
        createdAt:new Date().toISOString()
      }
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("PIX:", e);
    if (e.code === "23505") {
      return res.status(409).json({ error:"Não foi possível gerar um código único para o Pix. Tente novamente." });
    }
    res.status(500).json({ error:"Não foi possível enviar o Pix." });
  } finally {
    client.release();
  }
});

app.post("/api/pix/qr", async (req,res) => {
  try {
    const QRCode = require("qrcode");
    const pixKey = String(req.body?.pixKey || "").trim().toLowerCase();
    if (!pixKey) return res.status(400).json({ error:"Chave Pix não informada." });

    const data = await QRCode.toDataURL(`FICTIBANK|PIX|${pixKey}`);
    res.json({ pixKey, qr:data });
  } catch (e) {
    console.error("QR:", e);
    res.status(500).json({ error:"Não foi possível gerar o QR Code." });
  }
});

app.post("/api/notifications/read", async (req,res) => {
  try {
    const userId = Number(req.body?.userId);
    await pool.query("UPDATE notifications SET read=TRUE WHERE user_id=$1", [userId]);
    res.json({ ok:true });
  } catch {
    res.status(500).json({ error:"Não foi possível atualizar notificações." });
  }
});

app.get(/.*/, (req,res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`FictiBank online na porta ${PORT}`));
  })
  .catch(err => {
    console.error("Falha ao iniciar banco:", err);
    process.exit(1);
  });
