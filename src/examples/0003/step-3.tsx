import {
  Outlet,
  RouterProvider,
  Link,
  createRouter,
  createMemoryHistory,
  createRoute,
  createRootRoute,
  useLocation,
} from "@tanstack/react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const rootRoute = createRootRoute({
  component: function Root() {
    const location = useLocation();

    return (
      <div className="not-prose flex flex-col items-center justify-center border rounded-xl overflow-hidden my-8 bg-gray-50">
        <div className="w-full border-b px-4 py-2 text-sm bg-gray-100">
          <span className="text-muted-foreground">example.com</span>
          {location.pathname}
        </div>
        <div className="px-4 py-6 w-full h-48 flex flex-col">
          <Outlet />
        </div>
      </div>
    );
  },
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: function Index() {
    return (
      <div className="flex flex-col items-center justify-center flex-1">
        <Link to="/modal" className={buttonVariants()}>
          Open Modal
        </Link>

        <Outlet />
      </div>
    );
  },
});

const modalRoute = createRoute({
  getParentRoute: () => indexRoute,
  path: "/modal",
  component: function Modal() {
    const navigate = modalRoute.useNavigate();

    return (
      <Sheet
        open={true}
        onOpenChange={() => navigate({ to: "/", viewTransition: true })}
      >
        <SheetContent className="[view-transition-name:app-sheet-transition-broken]">
          <SheetHeader>
            <SheetTitle>Edit profile</SheetTitle>
            <SheetDescription>
              Make changes to your profile here. Click save when you&apos;re
              done.
            </SheetDescription>
          </SheetHeader>
          <SheetFooter>
            <Button type="submit">Save changes</Button>
            <SheetClose asChild>
              <Button variant="outline">Close</Button>
            </SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  },
});

const routeTree = rootRoute.addChildren([indexRoute.addChildren([modalRoute])]);

const history = createMemoryHistory({
  initialEntries: ["/"],
});

const router = createRouter({ routeTree, history });

export function Blog0003Step3() {
  return <RouterProvider router={router} />;
}
