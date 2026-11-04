// www.librecorsa.org → librecorsa.org, keeping the path, query and hash
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = "librecorsa.org";
    return Response.redirect(url.toString(), 301);
  },
};
