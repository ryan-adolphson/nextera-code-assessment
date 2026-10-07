/** SVG files imported as markup strings (angular.json `loader`: `.svg` → `text`). */
declare module '*.svg' {
  const markup: string;
  export default markup;
}
