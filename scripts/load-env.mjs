import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "..", ".env") });

console.log("DATABASE_URL loaded:", process.env.DATABASE_URL ? "YES" : "NO");
