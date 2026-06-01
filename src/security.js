import { config } from './config.js';

export function requireServiceToken(req, res, next) {
  // Se SERVICE_TOKEN não estiver definido, aceita chamadas sem token.
  // Em produção, configure SERVICE_TOKEN no Railway.
  if (!config.serviceToken) return next();

  const authHeader = req.get('authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const headerToken = req.get('x-service-token') || '';
  const bodyToken = req.body?.service_token || '';
  const queryToken = req.query?.token || '';

  const received = bearer || headerToken || bodyToken || queryToken;

  if (received !== config.serviceToken) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      message: 'Token do serviço inválido ou ausente.'
    });
  }

  return next();
}
