
import jwt from 'jsonwebtoken';
const SECRET = process.env.AID_SECRET || 'dev-secret-change';
export function signSession(userId){
  // In this backend we simply use raw numeric/string id in cookie for simplicity
  return String(userId);
}
export function verifySession(sid){
  // For now sid is plain user id
  return sid || null;
}
