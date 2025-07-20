import open from 'open';
import express from 'express';
import chalk from 'chalk';
import { apiFetch } from '../utils/api.js';

const REDIRECT_URI = 'http://localhost:3000/callback';

// Start OAuth 1.0a flow using backend endpoints
export async function startOAuth1aFlow() {
  return new Promise(async (resolve, reject) => {
    let requestToken;
    
    // Create Express app for handling callback
    const app = express();
    let server;
    
    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      if (server) {
        server.close();
      }
      reject(new Error('Authentication timed out after 5 minutes'));
    }, 5 * 60 * 1000);
    
    // Handle callback
    app.get('/callback', async (req, res) => {
      try {
        const { oauth_token, oauth_verifier, denied } = req.query;
        
        if (denied) {
          res.send(`
            <html>
              <body>
                <h1>❌ Authentication Denied</h1>
                <p>You denied the authorization request.</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);
          clearTimeout(timeout);
          server.close();
          return reject(new Error('User denied authorization'));
        }
        
        if (!oauth_token || !oauth_verifier) {
          res.send(`
            <html>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p>Invalid response from Twitter</p>
                <p>You can close this window and try again.</p>
              </body>
            </html>
          `);
          clearTimeout(timeout);
          server.close();
          return reject(new Error('Invalid OAuth response'));
        }
        
        // Verify with backend
        console.log(chalk.blue('🔐 Verifying with backend...'));
        
        const verifyResponse = await apiFetch('/api/auth/oauth/verify', {
          method: 'POST',
          body: JSON.stringify({
            oauth_token,
            oauth_verifier
          })
        });
        
        if (!verifyResponse.ok) {
          const error = await verifyResponse.text();
          throw new Error(`Verification failed: ${error}`);
        }
        
        const authData = await verifyResponse.json();
        
        res.send(`
          <html>
            <body>
              <h1>✅ Authentication Successful!</h1>
              <p>Welcome ${authData.user.twitter_display_name} (@${authData.user.twitter_username})!</p>
              <p>You can close this window and return to the terminal.</p>
              <script>
                setTimeout(() => {
                  window.close();
                }, 2000);
              </script>
            </body>
          </html>
        `);
        
        clearTimeout(timeout);
        server.close();
        
        resolve({
          success: true,
          oauth_token: authData.user.oauth_token,
          oauth_token_secret: authData.user.oauth_token_secret,
          userId: authData.user.twitter_user_id,
          username: authData.user.twitter_username,
          displayName: authData.user.twitter_display_name,
          oauthVersion: '1.0a'
        });
        
      } catch (error) {
        res.send(`
          <html>
            <body>
              <h1>❌ Authentication Failed</h1>
              <p>Error: ${error.message}</p>
              <p>You can close this window and try again.</p>
            </body>
          </html>
        `);
        
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });
    
    // Start server
    server = app.listen(3000, async (err) => {
      if (err) {
        clearTimeout(timeout);
        return reject(err);
      }
      
      try {
        // Step 1: Get auth URL from backend
        console.log(chalk.blue('🔑 Getting authentication URL from server...'));
        
        const requestResponse = await apiFetch('/api/auth/oauth/request');
        
        if (!requestResponse.ok) {
          const error = await requestResponse.text();
          throw new Error(`Failed to start OAuth flow: ${error}`);
        }
        
        const { auth_url, request_token } = await requestResponse.json();
        requestToken = request_token;
        
        console.log(chalk.blue('🌐 Starting local server on port 3000...'));
        console.log(chalk.yellow('📱 Opening browser for Twitter authentication...'));
        console.log();
        console.log(chalk.gray('If your browser doesn\'t open automatically, visit:'));
        console.log(chalk.cyan(auth_url));
        console.log();
        console.log(chalk.green('✨ If you\'re already logged into Twitter,'));
        console.log(chalk.green('   you\'ll skip directly to the authorization screen!'));
        console.log();
        
        // Open the authenticate URL
        open(auth_url).catch((err) => {
          console.log(chalk.yellow('⚠️ Could not open browser automatically'));
          console.log(chalk.gray('Please visit the URL shown above'));
        });
        
        console.log();
        console.log(chalk.yellow('⏳ Waiting for authorization...'));
        
      } catch (error) {
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });
  });
}

// Create OAuth 1.0a signed request helper for API calls
export function createOAuth1aSigner(oauthToken, oauthTokenSecret) {
  // This is now handled by the backend
  // The CLI just needs to pass the tokens to the backend
  return {
    signRequest(url, method = 'GET', data = {}) {
      // Return empty header since backend handles OAuth signing
      return {};
    }
  };
}