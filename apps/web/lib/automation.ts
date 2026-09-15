import "server-only";
import { getDb } from "@jobfinder/db";
import {
  automationOverview,
  createWatchlist,
  deleteWatchlist,
  generateDigest,
  listNotifications,
  listWatchlist,
  markNotifications,
  setSourceSchedule,
  unreadNotificationCount,
  updateWatchlist,
} from "@jobfinder/automation";

export const watchlist = {
  list: (userId: string) => listWatchlist(getDb(), userId),
  create: (userId: string, body: unknown) =>
    createWatchlist(getDb(), userId, body),
  update: (userId: string, id: string, body: unknown) =>
    updateWatchlist(getDb(), userId, id, body),
  remove: (userId: string, id: string) => deleteWatchlist(getDb(), userId, id),
};

export const alerts = {
  list: (userId: string, limit?: number) =>
    listNotifications(getDb(), userId, limit),
  unread: (userId: string) => unreadNotificationCount(getDb(), userId),
  mark: (userId: string, body: unknown) =>
    markNotifications(getDb(), userId, body),
};

export const automation = {
  overview: (userId: string) => automationOverview(getDb(), userId),
  digest: (userId: string, body: unknown) =>
    generateDigest(userId, { db: getDb(), body }),
  scheduleSource: (userId: string, sourceId: string, body: unknown) =>
    setSourceSchedule(getDb(), userId, sourceId, body),
};
