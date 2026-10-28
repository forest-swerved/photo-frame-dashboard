import { handleRequest } from '../server/app.js';
import { waitUntil } from '@vercel/functions';

const handle = request => handleRequest(request, { scheduleBackground: waitUntil });
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
