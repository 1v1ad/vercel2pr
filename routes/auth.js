import express from 'express'
import axios   from 'axios'
import jwt     from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import winston from 'winston'

const router = express.Router()
const prisma = new PrismaClient()

const log = winston.createLogger({
  transports: [ new winston.transports.Console({ format: winston.format.simple() }) ]
})

router.post('/vk-callback', async (req, res) => {
  try {
    const { code, deviceId, codeVerifier } = req.body
    if (!code || !deviceId)
      return res.status(400).json({ error: 'code & deviceId required' })

    const params = {
      client_id:     process.env.VK_CLIENT_ID,
      client_secret: process.env.VK_CLIENT_SECRET,
      code,
      device_id: deviceId,
      ...(codeVerifier && { code_verifier: codeVerifier })
    }

    const vkToken = await axios.get('https://oauth.vk.com/access_token', { params })
    if (vkToken.data.error)
      return res.status(401).json(vkToken.data)

    const { access_token, user_id } = vkToken.data

    const vkUser = (await axios.get('https://api.vk.com/method/users.get', {
      params: { user_ids: user_id, access_token, v: '5.236', fields: 'photo_200' }
    })).data.response[0]

    const user = await prisma.user.upsert({
      where:  { vkId: user_id },
      update: { firstName: vkUser.first_name, lastName: vkUser.last_name, avatar: vkUser.photo_200 },
      create: { vkId: user_id, firstName: vkUser.first_name, lastName: vkUser.last_name, avatar: vkUser.photo_200 }
    })

    const token = jwt.sign({ userId: user.id, vkId: user.vkId },
                           process.env.JWT_SECRET, { expiresIn: '7d' })

    log.info('login', { vkId: user.vkId, ip: req.ip })

    res.json({ token })

  } catch (err) {
    log.error(err)
    res.status(500).json({ error: 'internal', details: err.message })
  }
})

export default router
