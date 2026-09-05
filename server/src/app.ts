/**
 * Express wiring. This file connects things; it decides nothing.
 *
 * Order matters and is deliberate: parse the body, work out who is calling,
 * then route. Authorisation happens inside each router, because a router that
 * could be mounted without a guard is a router that eventually will be.
 */
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import { config } from './config/env.ts';
import { AppError } from './errors/app_error.ts';
import { authenticate } from './middleware/authenticate.ts';
import { errorHandler } from './middleware/error_handler.ts';
import { authRouter } from './routes/auth_routes.ts';
import { employeeRouter } from './routes/employee_routes.ts';
import { contractRouter } from './routes/contract_routes.ts';
import { scheduleRouter } from './routes/schedule_routes.ts';
import { attendanceRouter } from './routes/attendance_routes.ts';
import { timeOffRouter } from './routes/time_off_routes.ts';
import { salaryConfigRouter } from './routes/salary_config_routes.ts';
import { payrunRouter, payslipRouter } from './routes/payrun_routes.ts';
import { dashboardRouter } from './routes/dashboard_routes.ts';
import { referenceRouter } from './routes/reference_routes.ts';

/**
 * Hand-rolled CORS. The `cors` package is fifty lines of configuration handling
 * for what is, at one known origin with credentials, four headers. Reflecting a
 * single configured origin rather than '*' is also required: credentialed
 * requests are rejected by browsers when the origin is a wildcard.
 */
function crossOrigin(request: Request, response: Response, next: NextFunction): void {
  const origin = request.headers.origin;

  if (origin === config.webOrigin) {
    response.header('Access-Control-Allow-Origin', origin);
    response.header('Access-Control-Allow-Credentials', 'true');
    response.header('Access-Control-Allow-Headers', 'Content-Type');
    response.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    response.header('Vary', 'Origin');
  }

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  next();
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Only as many hops as are actually in front of us. See config/env.ts: trusting
  // the whole X-Forwarded-For chain lets a client choose the IP we audit.
  app.set('trust proxy', config.trustProxy);

  app.use(crossOrigin);
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticate);

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'peoplepay360' });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/employees', employeeRouter);
  app.use('/api/v1/contracts', contractRouter);
  app.use('/api/v1/working-schedules', scheduleRouter);
  app.use('/api/v1/attendance', attendanceRouter);
  app.use('/api/v1/time-off', timeOffRouter);
  app.use('/api/v1/salary', salaryConfigRouter);
  app.use('/api/v1/payruns', payrunRouter);
  app.use('/api/v1/payslips', payslipRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/reference', referenceRouter);

  app.use((request: Request, _response: Response, next: NextFunction) => {
    next(new AppError('not_found', `No route matches ${request.method} ${request.path}.`));
  });

  app.use(errorHandler);
  return app;
}
