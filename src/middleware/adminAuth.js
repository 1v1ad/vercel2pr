// src/middleware/adminAuth.js
const jwt = require('jsonwebtoken');

module.exports = function adminAuth(req, res, next){
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if(!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if(!decoded || decoded.role !== 'admin') return res.status(401).json({ error: 'Invalid token' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
