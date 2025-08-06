import jwt from 'jsonwebtoken';

export default function authRequired(req, res, next) {
  const token = (req.cookies?.jwt) ||
                (req.headers.authorization?.split(' ')[1]);

  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    req.jwt = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
