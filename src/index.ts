import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import productsRoutes from './routes/products.routes';
import storefrontRoutes from './routes/storefront.routes';
import webhooksRoutes from './routes/webhooks.routes';

dotenv.config();

const app = express();
app.use(cors());

// Stripe needs the raw, unparsed body to verify its signature -- this must
// be mounted before the global express.json() below, not after.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', authRoutes);
app.use('/products', productsRoutes);
app.use('/', storefrontRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Kazii+ backend listening on port ${PORT}`);
});
