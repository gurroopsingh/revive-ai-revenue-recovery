import { Router } from 'express';
import { dashboardRouter } from './dashboard';
import { opportunitiesRouter } from './opportunities';
import { agentRouter } from './agent';
import { simulationRouter } from './simulation';
import { configRouter } from './config';
import { analyticsRouter } from './analytics';
import { razorpayWebhookRouter } from './razorpayWebhook';

export const apiRouter = Router();

apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/opportunities', opportunitiesRouter);
apiRouter.use('/agent', agentRouter);
apiRouter.use('/simulation', simulationRouter);
apiRouter.use('/config', configRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/razorpay', razorpayWebhookRouter);
