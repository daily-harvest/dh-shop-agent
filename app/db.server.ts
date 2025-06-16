import { D1Database } from '@cloudflare/workers-types';

declare global {
  var d1GlobalDb: D1Database | undefined;
}

// Interfaces for our data structures
interface CodeVerifier {
  id: string;
  state: string;
  verifier: string;
  expiresAt: Date;
}

interface CustomerToken {
  id: string;
  conversationId: string;
  accessToken: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface Conversation {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
}

interface CustomerAccountUrl {
  conversationId: string;
  url: string;
  updatedAt: Date;
}

// For development, we might want to use a cached instance
// For production, we'll always get the fresh instance from env
const getDb = (env?: { DB: D1Database }): D1Database => {
  if (process.env.NODE_ENV !== "production") {
    // In development, use cached instance if available
    if (!global.d1GlobalDb && env?.DB) {
      global.d1GlobalDb = env.DB;
    }
    return global.d1GlobalDb;
  }
  
  // In production, always use the environment binding
  return env?.DB;
};

// Helper functions for common database operations
export const executeQuery = async (db: D1Database, query: string, params: any[] = []) => {
  const statement = db.prepare(query);
  if (params.length > 0) {
    statement.bind(...params);
  }
  return await statement.run();
};

export const getAllRows = async (db: D1Database, query: string, params: any[] = []) => {
  const statement = db.prepare(query);
  if (params.length > 0) {
    statement.bind(...params);
  }
  return await statement.all();
};

export const getFirstRow = async (db: D1Database, query: string, params: any[] = []) => {
  const statement = db.prepare(query);
  if (params.length > 0) {
    statement.bind(...params);
  }
  return await statement.first();
};

/**
 * Store a code verifier for PKCE authentication
 * @param {D1Database} db - D1 database instance
 * @param {string} state - The state parameter used in OAuth flow
 * @param {string} verifier - The code verifier to store
 * @returns {Promise<CodeVerifier>} - The saved code verifier object
 */
export async function storeCodeVerifier(db: D1Database, state: string, verifier: string): Promise<CodeVerifier> {
  // Calculate expiration date (10 minutes from now)
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 10);
  const id = `cv_${Date.now()}`;

  try {
    const query = `
      INSERT INTO codeVerifier (id, state, verifier, expiresAt) 
      VALUES (?, ?, ?, ?)
    `;
    await executeQuery(db, query, [id, state, verifier, expiresAt.toISOString()]);
    
    return { id, state, verifier, expiresAt };
  } catch (error) {
    console.error('Error storing code verifier:', error);
    throw error;
  }
}

/**
 * Get a code verifier by state parameter
 * @param {D1Database} db - D1 database instance
 * @param {string} state - The state parameter used in OAuth flow
 * @returns {Promise<CodeVerifier|null>} - The code verifier object or null if not found
 */
export async function getCodeVerifier(db: D1Database, state: string): Promise<CodeVerifier | null> {
  try {
    const now = new Date().toISOString();
    const query = `
      SELECT * FROM codeVerifier 
      WHERE state = ? AND expiresAt > ?
      LIMIT 1
    `;
    
    const verifier = await getFirstRow(db, query, [state, now]) as CodeVerifier;

    if (verifier) {
      // Delete it after retrieval to prevent reuse
      await executeQuery(db, `DELETE FROM codeVerifier WHERE id = ?`, [verifier.id]);
      return verifier;
    }

    return null;
  } catch (error) {
    console.error('Error retrieving code verifier:', error);
    return null;
  }
}

/**
 * Store a customer access token in the database
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID to associate with the token
 * @param {string} accessToken - The access token to store
 * @param {Date} expiresAt - When the token expires
 * @returns {Promise<CustomerToken>} - The saved customer token
 */
export async function storeCustomerToken(
  db: D1Database,
  conversationId: string, 
  accessToken: string, 
  expiresAt: Date
): Promise<CustomerToken> {
  try {
    // Check if a token already exists for this conversation
    const existingToken = await getFirstRow(
      db, 
      `SELECT * FROM customerToken WHERE conversationId = ?`,
      [conversationId]
    ) as CustomerToken;

    const now = new Date();
    
    if (existingToken) {
      // Update existing token
      await executeQuery(
        db,
        `UPDATE customerToken SET accessToken = ?, expiresAt = ?, updatedAt = ? WHERE id = ?`,
        [accessToken, expiresAt.toISOString(), now.toISOString(), existingToken.id]
      );
      
      return {
        ...existingToken,
        accessToken,
        expiresAt,
        updatedAt: now
      };
    }

    // Create a new token record
    const id = `ct_${Date.now()}`;
    await executeQuery(
      db,
      `INSERT INTO customerToken (id, conversationId, accessToken, expiresAt, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, conversationId, accessToken, expiresAt.toISOString(), now.toISOString(), now.toISOString()]
    );
    
    return {
      id,
      conversationId,
      accessToken,
      expiresAt,
      createdAt: now,
      updatedAt: now
    };
  } catch (error) {
    console.error('Error storing customer token:', error);
    throw error;
  }
}

/**
 * Get a customer access token by conversation ID
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<CustomerToken|null>} - The customer token or null if not found/expired
 */
export async function getCustomerToken(db: D1Database, conversationId: string): Promise<CustomerToken | null> {
  try {
    const now = new Date().toISOString();
    const token = await getFirstRow(
      db,
      `SELECT * FROM customerToken WHERE conversationId = ? AND expiresAt > ?`,
      [conversationId, now]
    ) as CustomerToken;

    return token || null;
  } catch (error) {
    console.error('Error retrieving customer token:', error);
    return null;
  }
}

/**
 * Create or update a conversation in the database
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Conversation>} - The created or updated conversation
 */
export async function createOrUpdateConversation(db: D1Database, conversationId: string): Promise<Conversation> {
  try {
    const now = new Date();
    const existingConversation = await getFirstRow(
      db,
      `SELECT * FROM conversation WHERE id = ?`,
      [conversationId]
    ) as Conversation;

    if (existingConversation) {
      await executeQuery(
        db,
        `UPDATE conversation SET updatedAt = ? WHERE id = ?`,
        [now.toISOString(), conversationId]
      );
      
      return {
        ...existingConversation,
        updatedAt: now
      };
    }

    await executeQuery(
      db,
      `INSERT INTO conversation (id, createdAt, updatedAt) VALUES (?, ?, ?)`,
      [conversationId, now.toISOString(), now.toISOString()]
    );
    
    return {
      id: conversationId,
      createdAt: now,
      updatedAt: now
    };
  } catch (error) {
    console.error('Error creating/updating conversation:', error);
    throw error;
  }
}

/**
 * Save a message to the database
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID
 * @param {string} role - The message role (user or assistant)
 * @param {string} content - The message content
 * @returns {Promise<Message>} - The saved message
 */
export async function saveMessage(
  db: D1Database,
  conversationId: string, 
  role: string, 
  content: string
): Promise<Message> {
  try {
    // Ensure the conversation exists
    await createOrUpdateConversation(db, conversationId);
    
    const now = new Date();
    const id = `msg_${Date.now()}`;
    
    // Create the message
    await executeQuery(
      db,
      `INSERT INTO message (id, conversationId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)`,
      [id, conversationId, role, content, now.toISOString()]
    );
    
    return {
      id,
      conversationId,
      role,
      content,
      createdAt: now
    };
  } catch (error) {
    console.error('Error saving message:', error);
    throw error;
  }
}

/**
 * Get conversation history
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<Message[]>} - Array of messages in the conversation
 */
export async function getConversationHistory(db: D1Database, conversationId: string): Promise<Message[]> {
  try {
    const result = await getAllRows(
      db,
      `SELECT * FROM message WHERE conversationId = ? ORDER BY createdAt ASC`,
      [conversationId]
    );
    
    return result.results as Message[];
  } catch (error) {
    console.error('Error retrieving conversation history:', error);
    return [];
  }
}

/**
 * Store customer account URL for a conversation
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID
 * @param {string} url - The customer account URL
 * @returns {Promise<CustomerAccountUrl>} - The saved URL object
 */
export async function storeCustomerAccountUrl(
  db: D1Database,
  conversationId: string, 
  url: string
): Promise<CustomerAccountUrl> {
  try {
    const now = new Date();
    
    // Check if record exists
    const existing = await getFirstRow(
      db,
      `SELECT * FROM customerAccountUrl WHERE conversationId = ?`,
      [conversationId]
    );
    
    if (existing) {
      await executeQuery(
        db,
        `UPDATE customerAccountUrl SET url = ?, updatedAt = ? WHERE conversationId = ?`,
        [url, now.toISOString(), conversationId]
      );
    } else {
      await executeQuery(
        db,
        `INSERT INTO customerAccountUrl (conversationId, url, updatedAt) VALUES (?, ?, ?)`,
        [conversationId, url, now.toISOString()]
      );
    }
    
    return {
      conversationId,
      url,
      updatedAt: now
    };
  } catch (error) {
    console.error('Error storing customer account URL:', error);
    throw error;
  }
}

/**
 * Get customer account URL for a conversation
 * @param {D1Database} db - D1 database instance
 * @param {string} conversationId - The conversation ID
 * @returns {Promise<string|null>} - The customer account URL or null if not found
 */
export async function getCustomerAccountUrl(db: D1Database, conversationId: string): Promise<string | null> {
  try {
    const record = await getFirstRow(
      db,
      `SELECT * FROM customerAccountUrl WHERE conversationId = ?`,
      [conversationId]
    ) as CustomerAccountUrl;

    return record?.url || null;
  } catch (error) {
    console.error('Error retrieving customer account URL:', error);
    return null;
  }
}

export default getDb;