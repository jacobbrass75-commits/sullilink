const express = require('express');
const { validateBody, z } = require('../validation');
const { handleAssistantMessage } = require('../../assistant/chat');

const router = express.Router();

const assistantSchema = z.object({
  message: z.string().trim().min(1, 'message is required'),
  session_id: z.string().trim().min(1).optional(),
  channel: z.string().trim().min(1).optional(),
  channel_chat_id: z.string().trim().min(1).optional(),
  channel_thread_id: z.string().trim().min(1).optional(),
  user_id: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  auto_execute: z.coerce.boolean().optional()
});

router.post('/api/assistant/chat', validateBody(assistantSchema), async (req, res, next) => {
  try {
    return res.json(await handleAssistantMessage(req.validatedBody));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
