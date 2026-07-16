/** Entrypoint de la API: PORT + DATABASE_URL (cap. 6.2). Servida tras el gateway bajo /api/v1. */
import { createDb } from "./db/connection.js";
import { createApp } from "./app.js";

const db = createDb();
const app = createApp({ db });
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`API de plataforma escuchando en :${port}`);
});
