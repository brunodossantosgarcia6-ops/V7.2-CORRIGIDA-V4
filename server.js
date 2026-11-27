const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function money(v) {
  return Math.round(Number(v) * 100) / 100;
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        pix_key TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('pix_in','pix_out','deposit')),
        amount NUMERIC(14,2) NOT NULL,
        description TEXT NOT NULL,
        counterparty TEXT,
        tx_code TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const seedUsers = [
      ["bruno", "Bruno", "Bruno*1902", 1250.00, "bruno@fictibank"],
      ["irmao", "Irmão", "4321", 650.00, "irmao@fictibank"]
    ];

    for (const [username, displayName, password, balance, pixKey] of seedUsers) {
      const exists = await client.query("SELECT id FROM users WHERE username=$1", [username]);
      if (exists.rowCount === 0) {
        const hash = await bcrypt.hash(password, 10);
        const ins = await client.query(
          `INSERT INTO users(username,display_name,password_hash,balance,pix_key)
           VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [username, displayName, hash, balance, pixKey]
        );
        const initTxCode = `INIT-${ins.rows[0].id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        await client.query(
          `INSERT INTO transactions(user_id,type,amount,description,tx_code)
           VALUES($1,'deposit',$2,'Saldo inicial',$3)`,
          [ins.rows[0].id, balance, initTxCode]
        );
      } else {
        // Corrige apenas a senha seed caso a conta já exista sem alterar o saldo do usuário.
        const hash = await bcrypt.hash(password, 10);
        await client.query(
          `UPDATE users SET display_name=$2, password_hash=$3, pix_key=$4 WHERE username=$1`,
          [username, displayName, hash, pixKey]
        );
      }
    }

    await client.query("COMMIT");
    console.log("PostgreSQL conectado e estrutura do FictiBank pronta.");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function requireFields(body, fields) {
  return fields.every((f) => body && body[f] !== undefined && body[f] !== null && String(body[f]).trim() !== "");
}

app.get("/api/ping", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW() AS now");
    res.json({ ok: true, database: "postgresql", time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    if (!requireFields(req.body, ["username","password","displayName"])) {
      return res.status(400).json({ error: "Preencha usuário, senha e nome." });
    }
    const username = String(req.body.username).trim().toLowerCase();
    const password = String(req.body.password);
    const displayName = String(req.body.displayName).trim();

    if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
      return res.status(400).json({ error: "Usuário deve ter 3-20 caracteres: letras, números, ponto, _ ou -." });
    }
    if (password.length < 4) return res.status(400).json({ error: "A senha precisa ter pelo menos 4 caracteres." });

    const key = `${username}@fictibank`;
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users(username,display_name,password_hash,balance,pix_key)
       VALUES($1,$2,$3,0,$4) RETURNING id,username,display_name,balance,pix_key`,
      [username, displayName, hash, key]
    );
    res.status(201).json({ user: r.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Esse usuário ou chave Pix já existe." });
    res.status(500).json({ error: "Não foi possível criar a conta." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const r = await pool.query(
      `SELECT id,username,display_name,password_hash,balance,pix_key FROM users WHERE username=$1`,
      [username]
    );
    if (!r.rowCount) return res.status(401).json({ error: "Usuário ou senha incorretos." });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "Usuário ou senha incorretos." });
    delete u.password_hash;
    res.json({ user: u });
  } catch (e) {
    res.status(500).json({ error: "Erro ao entrar." });
  }
});

app.get("/api/account/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const u = await pool.query(
      `SELECT id,username,display_name,balance,pix_key,created_at FROM users WHERE id=$1`,
      [id]
    );
    if (!u.rowCount) return res.status(404).json({ error: "Usuário não encontrado." });

    const tx = await pool.query(
      `SELECT id,type,amount,description,counterparty,tx_code,created_at
       FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [id]
    );
    const notes = await pool.query(
      `SELECT id,title,message,read,created_at FROM notifications
       WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [id]
    );
    res.json({ user: u.rows[0], transactions: tx.rows, notifications: notes.rows });
  } catch (e) {
    res.status(500).json({ error: "Não foi possível carregar a conta." });
  }
});

app.get("/api/users", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,username,display_name,pix_key,balance FROM users ORDER BY display_name`
    );
    res.json({ users: r.rows });
  } catch (e) {
    res.status(500).json({ error: "Erro ao carregar usuários." });
  }
});

app.post("/api/add-money", async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.body?.userId);
    const amount = money(req.body?.amount);
    if (!userId || !amount || amount <= 0 || amount > 1000000) {
      return res.status(400).json({ error: "Valor inválido." });
    }

    const txCode = "DEP-" + Date.now() + "-" + Math.floor(Math.random()*1000);
    await client.query("BEGIN");
    const u = await client.query(
      `UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING id,balance`,
      [amount, userId]
    );
    if (!u.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Usuário não encontrado." });
    }
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description,tx_code)
       VALUES($1,'deposit',$2,'Adição de saldo fictícia',$3)`,
      [userId, amount, txCode]
    );
    await client.query(
      `INSERT INTO notifications(user_id,title,message)
       VALUES($1,'Saldo adicionado', $2)`,
      [userId, `R$ ${amount.toFixed(2).replace(".",",")} foram adicionados à sua conta fictícia.`]
    );
    await client.query("COMMIT");
    res.json({ ok: true, balance: u.rows[0].balance, txCode });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ error: "Não foi possível adicionar o saldo." });
  } finally {
    client.release();
  }
});

app.post("/api/pix", async (req, res) => {
  const client = await pool.connect();
  try {
    const fromId = Number(req.body?.fromUserId);
    const key = String(req.body?.pixKey || "").trim().toLowerCase();
    const amount = money(req.body?.amount);

    if (!fromId || !key || !amount || amount <= 0 || amount > 1000000) {
      return res.status(400).json({ error: "Dados do Pix inválidos." });
    }

    await client.query("BEGIN");

    const from = await client.query(
      `SELECT id,username,display_name,balance,pix_key FROM users WHERE id=$1 FOR UPDATE`,
      [fromId]
    );
    const to = await client.query(
      `SELECT id,username,display_name,balance,pix_key FROM users WHERE LOWER(pix_key)=LOWER($1) FOR UPDATE`,
      [key]
    );

    if (!from.rowCount) throw new Error("Usuário remetente não encontrado.");
    if (!to.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Chave Pix não encontrada." });
    }
    if (from.rows[0].id === to.rows[0].id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Você não pode enviar Pix para sua própria conta." });
    }
    if (Number(from.rows[0].balance) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Saldo insuficiente." });
    }

    const code = "PIX-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random()*10000).toString().padStart(4,"0");

    await client.query(`UPDATE users SET balance=balance-$1 WHERE id=$2`, [amount, fromId]);
    await client.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`, [amount, to.rows[0].id]);

    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description,counterparty,tx_code)
       VALUES($1,'pix_out',$2,'Pix enviado',$3,$4)`,
      [fromId, -amount, to.rows[0].display_name, code]
    );
    await client.query(
      `INSERT INTO transactions(user_id,type,amount,description,counterparty,tx_code)
       VALUES($1,'pix_in',$2,'Pix recebido',$3,$4)`,
      [to.rows[0].id, amount, from.rows[0].display_name, code]
    );

    await client.query(
      `INSERT INTO notifications(user_id,title,message)
       VALUES($1,'Pix recebido',$2)`,
      [to.rows[0].id, `${from.rows[0].display_name} enviou R$ ${amount.toFixed(2).replace(".",",")} para você.`]
    );
    await client.query(
      `INSERT INTO notifications(user_id,title,message)
       VALUES($1,'Pix enviado',$2)`,
      [fromId, `Pix de R$ ${amount.toFixed(2).replace(".",",")} enviado para ${to.rows[0].display_name}.`]
    );

    await client.query("COMMIT");

    const newBalance = await pool.query(`SELECT balance FROM users WHERE id=$1`, [fromId]);
    res.json({
      ok: true,
      txCode: code,
      amount,
      receiver: { name: to.rows[0].display_name, pixKey: to.rows[0].pix_key },
      balance: newBalance.rows[0].balance
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ error: e.message || "Não foi possível realizar o Pix." });
  } finally {
    client.release();
  }
});

app.get("/api/pix/qr", async (req, res) => {
  try {
    const key = String(req.query.key || "").trim();
    if (!key) return res.status(400).json({ error: "Chave Pix ausente." });
    const payload = JSON.stringify({ type: "fictibank-pix", pixKey: key });
    const dataUrl = await QRCode.toDataURL(payload, { width: 360, margin: 2 });
    res.json({ pixKey: key, qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: "Não foi possível gerar o QR Code." });
  }
});

app.post("/api/notifications/read", async (req, res) => {
  try {
    const userId = Number(req.body?.userId);
    await pool.query(`UPDATE notifications SET read=true WHERE user_id=$1`, [userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Não foi possível atualizar notificações." });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`FictiBank V7.2 online na porta ${PORT}`));
  })
  .catch((e) => {
    console.error("Falha ao iniciar:", e);
    process.exit(1);
  });
