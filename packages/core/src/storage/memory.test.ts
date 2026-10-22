import { createMemoryStores } from './memory/index.js';
import { runRepositorySuite } from './repository.suite.js';

runRepositorySuite('memory', (deps) => createMemoryStores(deps));
