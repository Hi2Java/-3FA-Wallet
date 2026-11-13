# 3FA Wallet

A final year project prototype for a three-factor wallet system using:
- Email and password
- OTP verification
- Transaction PIN

## Features
- User registration with hashed password and PIN
- Login with OTP verification
- Dashboard balance display
- Transfer money with PIN confirmation
- Transaction history page
- Change password and PIN
- Forgot password and reset PIN flows

## Project Structure
- `server.js` - Express routes and wallet logic
- `db.js` - MySQL connection
- `views/` - HTML pages
- `public/` - shared CSS and popup helper
- `.env.example` - sample environment settings
- `schema.sql` - sample database schema

## Setup
1. Install dependencies:
   `npm install`
2. Create the database in MySQL.
3. Run the SQL in `schema.sql`.
4. Configure environment variables if needed.
5. Start the server:
   `npm start`
6. Open:
   `http://localhost:3000`

## Default Database Name
`fyp_database`

## Notes
- OTP is currently a demo OTP printed to the server console.
- Protected actions use session login and PIN verification.
- Transaction history depends on the transaction table in MySQL.
