'use strict';
module.exports = async () => {
  if (globalThis.__MONGO_RS__) await globalThis.__MONGO_RS__.stop();
};
