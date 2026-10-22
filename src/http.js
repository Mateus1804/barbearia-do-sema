'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function catchRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

// Rota de remoção por id; `table` é sempre uma constante do código (nunca vem do usuário).
function deleteById(db, table, notFoundMessage, successMessage) {
  return catchRoute((req, res) => {
    const result = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(Number(req.params.id));
    if (!result.changes) throw new HttpError(404, notFoundMessage);
    res.json({ message: successMessage });
  });
}

function handleError(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(err);
  let message = err.message;
  if (err.type === 'entity.parse.failed') message = 'Envie um JSON válido.';
  if (err.type === 'entity.too.large') message = 'O conteúdo enviado excede o limite de 40 KB.';
  res
    .status(status)
    .json({ error: status >= 500 ? 'Ocorreu um erro inesperado. Tente novamente.' : message });
}

module.exports = { HttpError, catchRoute, deleteById, handleError };
