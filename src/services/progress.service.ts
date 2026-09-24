import { logger } from "../utils/logger.js";
import { whatsappService } from "./whatsapp.service.js";

/** First ping once a chat request has been silent longer than people usually wait. */
const FIRST_UPDATE_MS = 10_000;
/** Second ping for long work (OCR, Xero, DBS login). */
const SECOND_UPDATE_MS = 45_000;

class ProgressService {
  async whileWorking<T>(phone: string, activity: string, work: () => Promise<T>): Promise<T> {
    if (!phone) return work();
    const stop = this.start(phone, activity);
    try {
      return await work();
    } finally {
      stop();
    }
  }

  start(phone: string, activity: string): () => void {
    let stopped = false;
    const ping = (text: string) => {
      if (stopped || !phone) return;
      void whatsappService.sendText(phone, text).catch((error) => {
        logger.warn({ err: error, phone, activity }, "Progress update failed to send");
      });
    };

    const first = setTimeout(() => {
      ping(`Still working on ${activity} — this can take a minute. I'll message you when it's done.`);
    }, FIRST_UPDATE_MS);

    const second = setTimeout(() => {
      ping(`Still on ${activity}. Almost there — I'll send the result shortly.`);
    }, SECOND_UPDATE_MS);

    return () => {
      stopped = true;
      clearTimeout(first);
      clearTimeout(second);
    };
  }
}

export const progressService = new ProgressService();
