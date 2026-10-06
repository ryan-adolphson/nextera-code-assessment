// `ng serve --configuration docker` (`npm run start:docker`): the compose `api` container
// (`docker compose up -d --wait --build api`, host port API_PORT, default 8080).
export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost:8080/api',
};
