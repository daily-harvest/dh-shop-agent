import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { D1Database } from "@cloudflare/workers-types";
import { Session } from "@shopify/shopify-api";
import { SessionStorage } from "@shopify/shopify-app-session-storage";

// Define type for the global DB
declare global {
  var shopifyDb: D1Database | undefined;
  var shopifyAppInstance: ReturnType<typeof shopifyApp> | undefined;
}

// Create a D1 session storage adapter
class D1SessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    const db = globalThis.shopifyDb;
    if (!db) {
      console.error("D1 database not initialized");
      return false;
    }

    try {
      await db.prepare(`INSERT OR REPLACE INTO shopify_sessions (id, shop, state, isOnline, scope, accessToken, expires, onlineAccessInfo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        session.id || null,
        session.shop || null,
        session.state || null,
        session.isOnline ? 1 : 0,
        session.scope || null,
        session.accessToken || null,
        session.expires ? session.expires.getTime() : null,
        session.onlineAccessInfo ? JSON.stringify(session.onlineAccessInfo) : null
      ).run();
      return true;
    } catch (error) {
      console.error("Failed to store session:", error);
      return false;
    }
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const db = globalThis.shopifyDb;
    if (!db) {
      console.error("D1 database not initialized");
      return undefined;
    }

    try {
      const result = await db.prepare(`SELECT * FROM shopify_sessions WHERE id = ?`).bind(id || null).first();
      
      if (!result) return undefined;
      
      const session = new Session({
        id: result.id as string,
        shop: result.shop as string,
        state: result.state as string,
        isOnline: Boolean(result.isOnline),
      });

      session.scope = result.scope as string;
      session.accessToken = result.accessToken as string;
      
      if (result.expires) {
        session.expires = new Date(result.expires as number);
      }
      
      if (result.onlineAccessInfo) {
        session.onlineAccessInfo = JSON.parse(result.onlineAccessInfo as string);
      }
      
      return session;
    } catch (error) {
      console.error("Failed to load session:", error);
      return undefined;
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    const db = globalThis.shopifyDb;
    if (!db) {
      console.error("D1 database not initialized");
      return false;
    }

    try {
      await db.prepare(`DELETE FROM shopify_sessions WHERE id = ?`).bind(id || null).run();
      return true;
    } catch (error) {
      console.error("Failed to delete session:", error);
      return false;
    }
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const db = globalThis.shopifyDb;
    if (!db) {
      console.error("D1 database not initialized");
      return false;
    }

    try {
      for (const id of ids) {
        await this.deleteSession(id);
      }
      return true;
    } catch (error) {
      console.error("Failed to delete sessions:", error);
      return false;
    }
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const db = globalThis.shopifyDb;
    if (!db) {
      console.error("D1 database not initialized");
      return [];
    }

    try {
      const results = await db.prepare(`SELECT * FROM shopify_sessions WHERE shop = ?`).bind(shop || null).all();
      
      return results.results.map(result => {
        const session = new Session({
          id: result.id as string,
          shop: result.shop as string,
          state: result.state as string,
          isOnline: Boolean(result.isOnline),
        });

        session.scope = result.scope as string;
        session.accessToken = result.accessToken as string;
        
        if (result.expires) {
          session.expires = new Date(result.expires as number);
        }
        
        if (result.onlineAccessInfo) {
          session.onlineAccessInfo = JSON.parse(result.onlineAccessInfo as string);
        }
        
        return session;
      });
    } catch (error) {
      console.error("Failed to find sessions by shop:", error);
      return [];
    }
  }
}

// Create a single instance of the session storage
const sessionStorage = new D1SessionStorage();

// Function to get or create the Shopify app instance
function getShopifyApp() {
  if (!globalThis.shopifyAppInstance) {
    globalThis.shopifyAppInstance = shopifyApp({
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      apiVersion: ApiVersion.January25,
      scopes: process.env.SCOPES?.split(","),
      appUrl: process.env.SHOPIFY_APP_URL || "",
      authPathPrefix: "/auth",
      sessionStorage,
      distribution: AppDistribution.AppStore,
      future: {
        unstable_newEmbeddedAuthStrategy: true,
        removeRest: true,
      },
      ...(process.env.SHOP_CUSTOM_DOMAIN
        ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
        : {}),
    });
  }
  return globalThis.shopifyAppInstance;
}

export const apiVersion = ApiVersion.January25;

// Lazy-load the shopify app when these functions are called
export const addDocumentResponseHeaders = (response: Response, request: Request) => {
  return getShopifyApp().addDocumentResponseHeaders(response, request);
};

export const authenticate = {
  admin: (request: Request) => {
    return getShopifyApp().authenticate.admin(request);
  },
  public: (request: Request) => {
    return getShopifyApp().authenticate.public(request);
  }
};

export const unauthenticated = {
  admin: (request: Request) => {
    return getShopifyApp().unauthenticated.admin(request);
  },
  public: (request: Request) => {
    return getShopifyApp().unauthenticated.public(request);
  }
};

export const login = (request: Request) => {
  return getShopifyApp().login(request);
};

export const registerWebhooks = (request: Request) => {
  return getShopifyApp().registerWebhooks(request);
};

// Function to initialize the database for the session storage
export async function initializeDb(db: D1Database) {
  try {
    // Create the sessions table if it doesn't exist
    await db.exec(`CREATE TABLE IF NOT EXISTS shopify_sessions (id TEXT PRIMARY KEY, shop TEXT NOT NULL, state TEXT, isOnline INTEGER, scope TEXT, accessToken TEXT, expires INTEGER, onlineAccessInfo TEXT)`);

    // Create Session table (from 20240530213853_create_session_table)
    await db.exec(`CREATE TABLE IF NOT EXISTS Session (id TEXT NOT NULL PRIMARY KEY, shop TEXT NOT NULL, state TEXT NOT NULL, isOnline BOOLEAN NOT NULL DEFAULT false, scope TEXT, expires DATETIME, accessToken TEXT NOT NULL, userId BIGINT, firstName TEXT, lastName TEXT, email TEXT, accountOwner BOOLEAN NOT NULL DEFAULT false, locale TEXT, collaborator BOOLEAN DEFAULT false, emailVerified BOOLEAN DEFAULT false)`);
    
    // Create CustomerToken table (from 20250501044923_add_customer_tokens_table)
    await db.exec(`CREATE TABLE IF NOT EXISTS CustomerToken (id TEXT NOT NULL PRIMARY KEY, conversationId TEXT NOT NULL, accessToken TEXT NOT NULL, refreshToken TEXT, expiresAt DATETIME NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
    
    await db.exec(`CREATE INDEX IF NOT EXISTS CustomerToken_conversationId_idx ON CustomerToken(conversationId)`);
    
    // Create CodeVerifier table (from 20250502141909_add_code_verifier_table)
    await db.exec(`CREATE TABLE IF NOT EXISTS CodeVerifier (id TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expiresAt DATETIME NOT NULL)`);
    
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS CodeVerifier_state_key ON CodeVerifier(state)`);
    
    await db.exec(`CREATE INDEX IF NOT EXISTS CodeVerifier_state_idx ON CodeVerifier(state)`);
    
    // Create Conversation and Message tables (from 20250508000001_add_conversation_tables)
    await db.exec(`CREATE TABLE IF NOT EXISTS Conversation (id TEXT NOT NULL PRIMARY KEY, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
    
    await db.exec(`CREATE TABLE IF NOT EXISTS Message (id TEXT NOT NULL PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT Message_conversationId_fkey FOREIGN KEY (conversationId) REFERENCES Conversation (id) ON DELETE CASCADE ON UPDATE CASCADE)`);
    
    await db.exec(`CREATE INDEX IF NOT EXISTS Message_conversationId_idx ON Message(conversationId)`);
    
    // Create CustomerAccountUrl table (from 20250520000001_add_customer_account_url_table)
    await db.exec(`CREATE TABLE IF NOT EXISTS CustomerAccountUrl (id TEXT NOT NULL PRIMARY KEY, conversationId TEXT NOT NULL, url TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`);
    
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS CustomerAccountUrl_conversationId_key ON CustomerAccountUrl(conversationId)`);

    // Set the global DB instance
    globalThis.shopifyDb = db;
    
    console.log("D1 database initialized successfully for session storage");
    return true;
  } catch (error) {
    console.error("Failed to initialize D1 database:", error);
    return false;
  }
}

// Add a function that can be called from load-context.ts
export function setupDb(env: any) {
  if (env?.DB && !globalThis.shopifyDb) {
    // Initialize the database if it exists and hasn't been initialized
    initializeDb(env.DB).catch(console.error);
  }
}

export default {
  apiVersion,
  authenticate,
  unauthenticated,
  login,
  registerWebhooks,
  addDocumentResponseHeaders
};