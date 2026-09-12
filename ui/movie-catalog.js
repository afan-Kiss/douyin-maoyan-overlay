/** @deprecated 请使用 ./data/movie-media.js */
export {
  DEFAULT_POSTER,
  normalizeMovieName,
  loadMovieMedia as loadMovieCatalog,
  findMovieMedia as findCatalogEntry,
  applyMediaToMovie as applyCatalogToMovie,
  applyMediaToMovies as applyCatalogToMovies,
  movieToTrailerItem,
  resolveTrailerFallback,
  buildTrailerPlaylist,
} from "./data/movie-media.js";
