import { DownloadJob, JobStatus } from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

type JobCallback = (job: DownloadJob) => Promise<void>;

class QueueService {
  private queue: DownloadJob[] = [];
  private processing: Set<string> = new Set();
  private jobCallback: JobCallback | null = null;
  private isRunning = false;

  setJobCallback(callback: JobCallback): void {
    this.jobCallback = callback;
  }

  addJob(job: DownloadJob): void {
    this.queue.push(job);
    logger.info(`Job queued: ${job.id} for user ${job.userId}`);
    
    if (!this.isRunning) {
      this.startProcessing();
    }
  }

  getJob(jobId: string): DownloadJob | undefined {
    return this.queue.find(job => job.id === jobId);
  }

  private async startProcessing(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logger.info('Queue processor started');

    while (this.queue.length > 0 || this.processing.size > 0) {
      // Process jobs up to concurrent limit
      while (
        this.processing.size < config.concurrentDownloads &&
        this.queue.length > 0
      ) {
        const job = this.queue.shift();
        if (job && job.status === JobStatus.QUEUED) {
          this.processJob(job);
        }
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.isRunning = false;
    logger.info('Queue processor stopped');
  }

  private async processJob(job: DownloadJob): Promise<void> {
    this.processing.add(job.id);
    job.status = JobStatus.DOWNLOADING;

    try {
      if (this.jobCallback) {
        await this.jobCallback(job);
      }
      job.status = JobStatus.COMPLETED;
    } catch (error) {
      job.status = JobStatus.FAILED;
      job.error = (error as Error).message;
      logger.error(`Job failed: ${job.id}`, error as Error);
    } finally {
      this.processing.delete(job.id);
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getProcessingCount(): number {
    return this.processing.size;
  }
}

export const queueService = new QueueService();
