'use strict';

const Store = require('electron-store');
const { randomUUID } = require('crypto');

class PrintControllerStore {
  constructor() {
    this.store = new Store({
      name: 'print-controllers',
      defaults: {
        controllers: {},
        productMappings: []
      }
    });
  }

  // ── Controller methods ──

  addController(controller) {
    const id = randomUUID();
    const now = new Date().toISOString();

    const controllers = this.store.get('controllers', {});
    controllers[id] = {
      ...controller,
      id,
      createdAt: now,
      updatedAt: now
    };

    this.store.set('controllers', controllers);
    return id;
  }

  getController(id) {
    const controllers = this.store.get('controllers', {});
    return controllers[id];
  }

  getAllControllers() {
    const controllers = this.store.get('controllers', {});
    return Object.values(controllers);
  }

  updateController(id, updates) {
    const controllers = this.store.get('controllers', {});
    if (controllers[id]) {
      controllers[id] = {
        ...controllers[id],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      this.store.set('controllers', controllers);
    }
  }

  deleteController(id) {
    const controllers = this.store.get('controllers', {});
    delete controllers[id];
    this.store.set('controllers', controllers);

    // Also delete associated product mappings
    const mappings = this.store.get('productMappings', []);
    this.store.set('productMappings', mappings.filter(m => m.controllerId !== id));
  }

  // ── Product Mapping methods ──

  addProductMapping(mapping) {
    const id = randomUUID();
    const mappings = this.store.get('productMappings', []);
    mappings.push({ ...mapping, id });
    this.store.set('productMappings', mappings);
    return id;
  }

  getProductMapping(id) {
    const mappings = this.store.get('productMappings', []);
    return mappings.find(m => m.id === id) || null;
  }

  getProductMappingsByController(controllerId) {
    const mappings = this.store.get('productMappings', []);
    return mappings.filter(m => m.controllerId === controllerId);
  }

  deleteProductMapping(id) {
    const mappings = this.store.get('productMappings', []);
    this.store.set('productMappings', mappings.filter(m => m.id !== id));
  }

  /**
   * Returns all known option names and their previously used values,
   * derived from every product mapping across all controllers.
   * @returns {{ [optionName: string]: string[] }}
   */
  getKnownOptions() {
    const mappings = this.store.get('productMappings', []);
    const result = {};
    for (const m of mappings) {
      for (const [k, v] of Object.entries(m.options || {})) {
        if (!result[k]) result[k] = new Set();
        if (v) result[k].add(v);
      }
    }
    // Convert Sets to sorted arrays
    return Object.fromEntries(
      Object.entries(result).map(([k, vs]) => [k, [...vs].sort()])
    );
  }

  // ── Channel lookup ──

  /**
   * Find a ProductMapping for the given job.
   * @param {string} controllerId
   * @param {string} productCode - job.product_code
   * @param {Object} options - key/value object from job options array e.g. { "Finish": "Matte" }
   * @returns {Object|null} matching ProductMapping or null
   */
  findChannelForJob(controllerId, productCode, options) {
    const mappings = this.getProductMappingsByController(controllerId);
    return mappings.find(m => {
      if (m.productCode !== productCode) return false;
      const mOpts = m.options || {};
      // All option key-value pairs in the mapping must match the job options
      return Object.entries(mOpts).every(([k, v]) => options[k] === v);
    }) || null;
  }
}

const printControllerStore = new PrintControllerStore();
module.exports = { printControllerStore, PrintControllerStore };
