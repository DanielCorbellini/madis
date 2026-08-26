import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { WhitelistChecker } from "./auth/whitelist.ts";
import type { RecordRepository } from "./domain/records/record-repository.ts";
import { recordRoutes } from "./domain/records/record-routes.ts";
import { registerErrorHandler } from "./plugins/error-handler.ts";

export interface AppDependencies {
  repository: RecordRepository;
  isClientAuthorized: WhitelistChecker;
  logger?: boolean;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.register(recordRoutes, {
    prefix: "/prescriptions",
    recordType: "prescription",
    repository: deps.repository,
    isClientAuthorized: deps.isClientAuthorized,
  });

  app.register(recordRoutes, {
    prefix: "/emr-encounters",
    recordType: "emr_encounter",
    repository: deps.repository,
    isClientAuthorized: deps.isClientAuthorized,
  });

  return app;
}
