# 3FA-Wallet

A web-based digital wallet prototype developed as my Final Year Project. The system uses three-factor authentication to provide an additional layer of security for wallet-related activities.

## Technologies Used

- JavaScript
- Node.js
- Express.js
- MySQL
- HTML
- CSS

## Key Features

- User registration with hashed passwords and transaction PINs
- Login with email and password, followed by OTP verification
- Dashboard with wallet balance display
- Money transfers with transaction PIN confirmation
- Transaction history
- Change password and transaction PIN
- Forgot password and PIN reset features

## Project Structure

- `server.js` – Express routes and wallet logic
- `db.js` – MySQL database connection
- `views/` – HTML pages
- `public/` – CSS files and popup helper
- `.env.example` – Sample environment configuration
- `schema.sql` – Sample database schema

## Screenshots

Screenshots of the application's main pages will be provided in this repository.

## How to Run Locally

1. Install dependencies using `npm install`.
2. Create a MySQL database.
3. Execute the SQL statements in `schema.sql`.
4. Configure the required environment variables.
5. Start the application using `npm start`.
6. Open `http://localhost:3000` in your browser.

## Default Database Name
`fyp_database`

## Project Notes and Limitations

- This project is an academic prototype and is not publicly deployed.
- OTP is currently implemented as a demo OTP printed in the server console.
- Protected actions use session-based login and transaction PIN verification.
- Transaction history depends on the transaction table in MySQL.
- Wallet top-up and transfer functions are simulated within the application and are not connected to a real payment gateway.
