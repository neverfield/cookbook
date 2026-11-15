export function pageCount(total, size) {
  if (size <= 0) {
    throw new RangeError("size must be positive");
  }
  return Math.ceil(total / size);
}

export function offset(page, size) {
  if (page < 1) {
    return 0;
  }
  return (page - 1) * size;
}

export function hasNext(page, pages) {
  return page < pages;
}

export function clampPage(page, pages) {
  if (page > pages) {
    return pages;
  }
  return page;
}
