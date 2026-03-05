'use strict';

const Store = require('electron-store');
const { randomUUID } = require('crypto');

class JobStore {
  constructor() {
    this.store = new Store({
      name: 'jobs',
      defaults: {
        jobs: {}
      }
    });
  }

  addJob(job) {
    const id = randomUUID();
    const jobs = this.store.get('jobs', {});

    jobs[id] = {
      ...job,
      id,
      dpofStatus: 'pending',
      createdAt: new Date().toISOString()
    };

    this.store.set('jobs', jobs);
    return id;
  }

  getJob(id) {
    const jobs = this.store.get('jobs', {});
    return jobs[id];
  }

  getJobByOrderNumber(orderNumber) {
    const jobs = this.store.get('jobs', {});
    return Object.values(jobs).find(j => j.orderNumber === orderNumber);
  }

  updateJob(id, updates) {
    const jobs = this.store.get('jobs', {});
    if (jobs[id]) {
      jobs[id] = {
        ...jobs[id],
        ...updates
      };
      this.store.set('jobs', jobs);
    }
  }

  updateJobStatus(orderNumber, status) {
    const jobs = this.store.get('jobs', {});
    const job = Object.values(jobs).find(j => j.orderNumber === orderNumber);

    if (job) {
      job.dpofStatus = status;

      const timestampField = `dpof${status.charAt(0).toUpperCase() + status.slice(1)}At`;
      job[timestampField] = new Date().toISOString();

      jobs[job.id] = job;
      this.store.set('jobs', jobs);
    }
  }

  getAllJobs() {
    const jobs = this.store.get('jobs', {});
    return Object.values(jobs);
  }

  getJobsByStatus(status) {
    return this.getAllJobs().filter(j => j.dpofStatus === status);
  }

  deleteJob(id) {
    const jobs = this.store.get('jobs', {});
    delete jobs[id];
    this.store.set('jobs', jobs);
  }
}

const jobStore = new JobStore();
module.exports = { jobStore, JobStore };
