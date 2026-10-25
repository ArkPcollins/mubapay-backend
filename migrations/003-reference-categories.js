'use strict';
/** Baseline product categories (reference data, safe for all environments). */
module.exports = {
  id: '003-reference-categories',
  description: 'Create baseline marketplace categories and prohibited categories',
  async up() {
    const { Category } = require('../src/modules/marketplace/marketplace.models');
    const cats = [
      ['Phones & Tablets', 'phones-tablets'], ['Computers & Accessories', 'computers'], ['Electronics', 'electronics'], ['Home & Kitchen', 'home-kitchen'],
      ['Fashion', 'fashion'], ['Baby & Kids', 'baby-kids'], ['Furniture', 'furniture'], ['Books & Stationery', 'books'], ['Sports & Fitness', 'sports'], ['Health & Beauty (sealed only)', 'health-beauty'],
    ];
    let i = 0;
    for (const [name, slug] of cats) {
      await Category.updateOne({ slug }, { $setOnInsert: { name, slug, sortOrder: i++, allowsUsed: slug !== 'health-beauty', allowsNew: true } }, { upsert: true });
    }
    for (const [name, slug, reason] of [['Weapons & Ammunition', 'weapons', 'Prohibited Items Policy'], ['Prescription Medicines', 'prescription-medicines', 'Prohibited Items Policy']]) {
      await Category.updateOne({ slug }, { $setOnInsert: { name, slug, prohibited: true, prohibitedReason: reason, active: true, sortOrder: 99 } }, { upsert: true });
    }
  },
};
