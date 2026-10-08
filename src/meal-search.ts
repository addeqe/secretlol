/** FTS5 phrase syntax with embedded quotes escaped as literal quote characters. */
export function mealSearchPhrase(query:string){return `"${query.replaceAll('"','""')}"`;}
