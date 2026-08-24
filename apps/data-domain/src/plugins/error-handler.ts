import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { AppError } from "../errors/app-errors.ts";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: error.message },
      });
      return;
    }

    request.log.error(error);
    reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });
}
