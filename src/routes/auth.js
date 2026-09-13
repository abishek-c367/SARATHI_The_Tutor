const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

function sign(user) {
  return jwt.sign({ id: user.id, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/signup', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const normEmail = email.toLowerCase().trim();
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [normEmail]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with that email already exists.' });

    const hashed = await bcrypt.hash(password, 10);
    const id = db.genId('user');
    const finalRole = role === 'ADMIN' ? 'ADMIN' : 'STUDENT';
    await db.query(
      'INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,$5)',
      [id, name, normEmail, hashed, finalRole]
    );
    const user = { id, name, role: finalRole };
    res.json({ token: sign(user), user });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: 'Incorrect email or password.' });
    const ok = await bcrypt.compare(password, row.password);
    if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
    const user = { id: row.id, name: row.name, role: row.role };
    res.json({ token: sign(user), user });
  } catch (e) { next(e); }
});

module.exports = router;
